import { execFile } from 'node:child_process'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import http from 'node:http'
import { existsSync, readlinkSync } from 'node:fs'
import { APP_BUNDLE_CANDIDATES, LOGS_DIR } from './paths.js'

const INTERVAL_SEC = 30
const GRACE_SEC = 300

export interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

export interface Evidence {
  sessionStartedAt: number
  lastActivityAt: number
  queuePosition: number | null
  queueUpdatedAt: number | null
  queueStatus: string | null
  queueId?: string | null
  queueStartedAt?: number | null
  trainingUpdatedAt?: number | null
  trainingPhase?: string | null
  trainingRunId?: string | null
  trainingState: string | null
  trainingAt: number | null
  exitCode: number | null
  exitedAt: number | null
  quitAt: number | null
  fatal: boolean
  p2pAnomalyAt?: number | null
  p2pAnomalyDetected: boolean
}

export interface HealthInfo {
  ok: boolean
  connected?: boolean
  expectedHostPid?: number
}

export type StatusKind = 'paused' | 'starting' | 'queued' | 'training' | 'waiting' | 'abnormal'

export function appBundlePath(): string {
  return APP_BUNDLE_CANDIDATES.find((p) => existsSync(p)) ?? APP_BUNDLE_CANDIDATES[0]
}

export function appExecutablePath(): string {
  return `${appBundlePath()}/Contents/MacOS/IOTA Train at Home`
}

export function workerExecutablePath(): string {
  return `${appBundlePath()}/Contents/Frameworks/iota-cli/main_pool`
}

export function execFileText(file: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

export async function processes(): Promise<Map<number, ProcessRow>> {
  const out = await execFileText('ps', ['-axo', 'pid=,ppid=,command='])
  const rows = new Map<number, ProcessRow>()
  for (const line of out.split('\n')) {
    const pieces = line.trim().split(/\s+/)
    if (pieces.length >= 3) {
      const pid = Number(pieces[0])
      const ppid = Number(pieces[1])
      if (Number.isFinite(pid) && Number.isFinite(ppid)) {
        rows.set(pid, { pid, ppid, command: pieces.slice(2).join(' ') })
      }
    }
  }
  return rows
}

const STAMP_RE = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\]/

async function tail(path: string, bytes: number): Promise<string> {
  const info = await stat(path)
  const handle = await open(path, 'r')
  try {
    const start = Math.max(0, info.size - bytes)
    const buffer = Buffer.alloc(info.size - start)
    await handle.read(buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

export interface LogRecord {
  t: number
  line: string
}

export function hostTimeZone(): string {
  // macOS /etc/localtime records the actual OS setting, unlike Intl's default
  // which can be overridden by a parent process's TZ environment variable.
  try {
    const target = readlinkSync('/etc/localtime')
    const zone = target.split('/zoneinfo/')[1]
    if (zone) {
      new Intl.DateTimeFormat('en', { timeZone: zone }).format()
      return zone
    }
  } catch {}
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
const LOG_TIME_ZONE = hostTimeZone()
const logFormatters = new Map<string, Intl.DateTimeFormat>()
export function parseLocalLogTimestamp(value: string, timeZone = LOG_TIME_ZONE): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+)$/.exec(value)
  if (!match) return Number.NaN
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match
  const year = Number(yearText), month = Number(monthText), day = Number(dayText)
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText)
  const millisecond = Number((fractionText ?? '').padEnd(3, '0').slice(0, 3))
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const check = new Date(wall)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return Number.NaN
  let formatter = logFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    logFormatters.set(timeZone, formatter)
  }
  const localWall = (at: number): number => {
    const parts = Object.fromEntries(formatter!.formatToParts(new Date(at)).map(p => [p.type, p.value]))
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second, millisecond)
  }
  let utc = wall
  for (let i = 0; i < 4; i++) {
    const delta = wall - localWall(utc)
    if (delta === 0) return utc / 1000
    utc += delta
  }
  // Reject nonexistent wall times during a spring DST transition.
  return localWall(utc) === wall ? utc / 1000 : Number.NaN
}

export async function logRecords(): Promise<LogRecord[]> {
  const records: LogRecord[] = []
  if (!existsSync(LOGS_DIR)) return records
  for (const kind of ['main', 'cli'] as const) {
    const files = (await readdir(LOGS_DIR))
      .filter((name) => name.includes(`-${kind}`) && name.endsWith('.log'))
      .map((name) => `${LOGS_DIR}/${name}`)
    const withMtime = await Promise.all(files.map(async (f) => ({ f, name: f.split('/').pop() ?? '', mtime: (await stat(f)).mtimeMs })))
    withMtime.sort((a, b) => b.mtime - a.mtime)
    // Read the newest file completely. Filenames may use UTC while log lines
    // use local time, so matching a calendar date can truncate the live log.
    const currentLog = withMtime[0]?.name
    // Older rotated files are bounded session/activity evidence.
    for (const { f, name } of withMtime.slice(0, 3)) {
      const info = await stat(f).catch(() => null)
      if (!info) continue
      const isCurrentLog = currentLog === name
      const text = isCurrentLog
        ? await tail(f, info.size).catch(() => '')
        : await tail(f, 512 * 1024).catch(() => '')
      for (const line of text.split('\n')) {
        const match = STAMP_RE.exec(line)
        if (match) {
          const t = parseLocalLogTimestamp(match[1]!)
          if (Number.isFinite(t)) records.push({ t, line })
        } else {
          const last = records.at(-1)
          if (last?.line.includes('training.state accepted') && !last.line.includes('}') && last.line.length < 8192) {
            last.line += `\n${line}`
          }
        }
      }
    }
  }
  records.sort((a, b) => a.t - b.t)
  return records
}

export function emptyEvidence(sessionStartedAt: number): Evidence {
  return {
    sessionStartedAt,
    lastActivityAt: sessionStartedAt,
    queuePosition: null,
    queueUpdatedAt: null,
    queueStatus: null,
    queueId: null,
    queueStartedAt: null,
    trainingUpdatedAt: null,
    trainingPhase: null,
    trainingRunId: null,
    trainingState: null,
    trainingAt: null,
    exitCode: null,
    exitedAt: null,
    quitAt: null,
    fatal: false,
    p2pAnomalyAt: null,
    p2pAnomalyDetected: false,
  }
}

export function parseLogs(records: LogRecord[], previous: Partial<GuardianState>): Evidence {
  const starts = records.filter((r) => r.line.includes('[iota-cli runIotaCli] Connecting to CHANNEL')).map((r) => r.t)
  const latestStart = starts.length > 0 ? Math.max(...starts) : null
  const previousStart = previous.sessionStartedAt ?? 0
  // Keep the latest session start across date-based log rotation; never fall back to an older date's start.
  const started = latestStart !== null ? Math.max(latestStart, previousStart) : previousStart
  const result = emptyEvidence(started)
  // Preserve evidence across rotation, never across a new miner session.
  if (started === previousStart && previous.sessionStartedAt !== undefined) {
    Object.assign(result, {
      lastActivityAt: previous.lastActivityAt ?? started,
      queuePosition: previous.queuePosition ?? null,
      queueUpdatedAt: previous.queueUpdatedAt ?? null,
      queueStatus: previous.queueStatus ?? null,
      queueId: previous.queueId ?? null,
      queueStartedAt: previous.queueStartedAt ?? null,
      trainingUpdatedAt: previous.trainingUpdatedAt ?? null,
      trainingPhase: previous.trainingPhase ?? null,
      trainingRunId: previous.trainingRunId ?? null,
      trainingState: previous.trainingState ?? null,
      trainingAt: previous.trainingAt ?? null,
      exitCode: previous.exitCode ?? null,
      exitedAt: previous.exitedAt ?? null,
      quitAt: previous.quitAt ?? null,
      fatal: previous.fatal ?? false,
      p2pAnomalyAt: previous.p2pAnomalyAt ?? null,
    })
  }
  for (const { t, line } of records) {
    if (t < started) continue
    if (!line.includes('[AutoUpdater]')) {
      result.lastActivityAt = Math.max(result.lastActivityAt, t)
    }
    if (line.includes('Successfully completed request to /miner/register') && line.includes('response:')) {
      const payload = line.split('response:')[1] ?? ''
      const status = /['"]status['"]\s*:\s*['"]([^'"]+)/.exec(payload)
      const position = /['"]position['"]\s*:\s*(\d+)/.exec(payload)
      if (status && t >= (result.queueUpdatedAt ?? 0)) {
        const queueId = /['"]queue_id['"]\s*:\s*['"]([^'"]+)/.exec(payload)?.[1] ?? null
        if (queueId && queueId !== result.queueId) result.queueStartedAt = t
        result.queueId = queueId
        result.queueStatus = status[1]
        result.queuePosition = position ? Number(position[1]) : null
        result.queueUpdatedAt = t
      }
    }
    const state = /training\.state accepted\s*\{\s*state:\s*['"]([^'"]+)/.exec(line)
    if (state && t >= (result.trainingUpdatedAt ?? 0)) {
      result.trainingState = state[1]
      result.trainingUpdatedAt = t
      result.trainingRunId = /runId:\s*['"]([^'"]+)/.exec(line)?.[1] ?? null
      result.trainingPhase = /to LayerPhase\.([A-Z_]+)/.exec(line)?.[1] ?? null
      if (state[1] === 'training' || state[1] === 'training_tick') {
        result.trainingAt = t
        if (t > (result.p2pAnomalyAt ?? 0)) result.p2pAnomalyAt = null
      } else if (state[1] === 'resetting' || state[1] === 'waiting_training') {
        result.trainingAt = null
      }
    }
    if (line.includes('Starting FORWARD pass') || line.includes('after training forward pass')) {
      result.trainingAt = Math.max(result.trainingAt ?? 0, t)
      if (t > (result.p2pAnomalyAt ?? 0)) result.p2pAnomalyAt = null
    }
    const exited = /miner process exited code=(\d+|null) signal=(\S+)/.exec(line)
    if (exited) {
      result.exitCode = /^\d+$/.test(exited[1]) ? Number(exited[1]) : -1
      result.exitedAt = t
    }
    if (line.includes('[iota-cli registerQuitHandler] Closing IOTA Cli')) {
      result.quitAt = t
    }
    if (line.includes('Miner control host gating failed') || line.includes('Failed to execute script')) {
      result.fatal = true
    }
    if (/No p2p_node_ids found on any adjacent-layer peer|No routable peers for layer-\d+/i.test(line)) {
      result.p2pAnomalyAt = t
    }
  }
  // A successful forward pass after a peer warning is recovery evidence.
  result.p2pAnomalyDetected = result.p2pAnomalyAt != null
    && result.p2pAnomalyAt > (result.trainingAt ?? 0)
  return result
}

export function health(): Promise<HealthInfo | null> {
  return new Promise((resolve) => {
    // Node 默认不读 HTTP_PROXY,回环请求天然不走代理
    const req = http.get('http://127.0.0.1:8010/health', { timeout: 3000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        if (chunks.reduce((n, c) => n + c.length, 0) > 65536) req.destroy()
      })
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(typeof data === 'object' && data !== null ? (data as HealthInfo) : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

export function classify(
  evidence: Evidence,
  appPid: number | null,
  minerAlive: boolean,
  control: HealthInfo | null,
  now: number,
): { status: StatusKind; description: string } {
  const started = evidence.sessionStartedAt
  if (!appPid) {
    return { status: 'paused', description: minerAlive ? 'IOTA 主程序未运行，仍有 main_pool 进程' : 'IOTA 主程序未运行，main_pool 未运行' }
  }
  if (!started && !minerAlive) {
    return { status: 'paused', description: '尚未启动过矿工;先打开 IOTA 并点击 Start training' }
  }
  if (evidence.quitAt && !appPid) {
    return { status: 'paused', description: '应用正常退出,保留手动停止意图' }
  }
  if (evidence.exitedAt && evidence.exitCode === 0 && !minerAlive) {
    return { status: 'paused', description: '矿工正常停止,等待手动启动或原有定时安排' }
  }
  if (appPid && now - started < GRACE_SEC) {
    const connected = Boolean(control?.connected && control.expectedHostPid === appPid)
    if (!connected) {
      return { status: 'starting', description: '矿工启动中,处于五分钟监控宽限期' }
    }
  }
  if (!appPid) {
    return { status: 'paused', description: 'IOTA 当前未运行；运行 ma start 启动' }
  }
  if (!minerAlive) {
    return { status: 'abnormal', description: '矿工进程已退出' }
  }
  if (!control?.ok) {
    return { status: 'abnormal', description: '本地矿工控制服务不可访问' }
  }
  if (control.expectedHostPid !== appPid || !control.connected) {
    return { status: 'abnormal', description: '矿工与桌面程序的控制连接断开' }
  }
  if (evidence.trainingAt && now - evidence.trainingAt < 300) {
    return { status: 'training', description: '最近五分钟有实际训练活动' }
  }
  if (evidence.queueStatus === 'queued') {
    const stale = now - (evidence.queueUpdatedAt ?? 0) > 900
    const base = evidence.queuePosition !== null ? `官方排队第 ${evidence.queuePosition} 位` : '等待官方分配训练任务'
    return { status: 'queued', description: base + (stale ? ';位置超过十五分钟未更新' : '') }
  }
  const registrationDescriptions: Record<string, string> = {
    confirming: '官方正在确认训练资格',
    confirmed: '官方已确认训练资格，等待任务准备',
    processing: '官方注册处理中，等待训练任务',
    succeeded: '官方注册成功，等待训练活动',
  }
  const registrationDescription = registrationDescriptions[evidence.queueStatus ?? '']
  if (registrationDescription) {
    const stale = now - (evidence.queueUpdatedAt ?? 0) > 900
    return { status: 'waiting', description: registrationDescription + (stale ? '；注册状态超过十五分钟未更新' : '') }
  }
  if (now - evidence.lastActivityAt > 1800) {
    return { status: 'waiting', description: '已超过三十分钟未读到新活动日志；控制连接正常，当前训练和排队状态无法仅凭日志确认' }
  }
  return { status: 'waiting', description: '控制连接正常,等待注册、模型准备或训练任务' }
}

export interface GuardianState {
  sessionStartedAt: number
  lastActivityAt: number
  queuePosition: number | null
  queueUpdatedAt: number | null
  queueStatus: string | null
  queueId?: string | null
  queueStartedAt?: number | null
  trainingUpdatedAt?: number | null
  trainingPhase?: string | null
  trainingRunId?: string | null
  trainingState: string | null
  trainingAt: number | null
  exitCode: number | null
  exitedAt: number | null
  quitAt: number | null
  fatal: boolean
  p2pAnomalyAt?: number | null
  p2pAnomalyDetected: boolean
  updatedAt: string
  status: StatusKind
  description: string
  appPid: number | null
  relayPid?: number | null
  port18010?: Array<{ pid: number; command: string }>
  minerAlive: boolean
  controlConnected: boolean
  agentStartedAt: number
  orphanedWorkerCount?: number
}


async function signal(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

// 终止前用 ps 重核命令行,防止 PID 复用误杀无关进程
function isIotaWorker(row: ProcessRow, worker: string): boolean {
  return row.command.startsWith(worker) || row.command.startsWith('main_pool:ai.macrocosmos.iota.tah.worker')
}

export function selectOrphanedIotaWorkers(rows: Map<number, ProcessRow>, app: string, worker: string): Map<number, ProcessRow> {
  const appRunning = [...rows.values()].some((row) => row.command === app)
  if (appRunning) return new Map()
  // 包内 main_pool 可执行文件和其 Python multiprocessing 子进程都属于该 worker。
  return new Map([...rows].filter(([, row]) => isIotaWorker(row, worker)))
}

export function orphanedIotaWorkers(rows: Map<number, ProcessRow>): Map<number, ProcessRow> {
  return selectOrphanedIotaWorkers(rows, appExecutablePath(), workerExecutablePath())
}

async function terminateTargets(targets: Map<number, string>, message: string): Promise<void> {
  if (targets.size === 0) return
  const alive = async (): Promise<boolean> => {
    const fresh = await processes()
    return [...targets].some(([pid, command]) => fresh.get(pid)?.command === command)
  }
  for (const [sig, timeoutSec] of [['SIGTERM', 20], ['SIGKILL', 3]] as const) {
    const fresh = await processes()
    for (const [pid, command] of targets) {
      if (fresh.get(pid)?.command === command) await signal(pid, sig)
    }
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      if (!(await alive())) return
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(message)
}

// 结束同一批已确认的 IOTA 进程;每次发信号前都重核命令行,防止 PID 复用误杀。
export async function terminateIota(rows: Map<number, ProcessRow>): Promise<void> {
  const worker = workerExecutablePath()
  const targets = new Map<number, string>()
  for (const [pid, row] of rows) {
    if (row.command === appExecutablePath() || isIotaWorker(row, worker)) targets.set(pid, row.command)
  }
  await terminateTargets(targets, 'IOTA 进程未能退出,未启动重复实例')
}

// 发送一次 TERM；信号前重新核对 PID 命令行，避免 PID 复用误杀。
async function terminateMatchingNow(select: (row: ProcessRow) => boolean): Promise<number> {
  const snapshot = await processes()
  const targets = [...snapshot].filter(([, row]) => select(row))
  const fresh = await processes()
  let signaled = 0
  for (const [pid, row] of targets) {
    if (fresh.get(pid)?.command !== row.command) continue
    await signal(pid, 'SIGTERM')
    signaled += 1
  }
  return signaled
}

export async function terminateIotaAppNow(): Promise<number> {
  const app = appExecutablePath()
  return terminateMatchingNow((row) => row.command === app)
}

export async function terminateIotaWorkersNow(): Promise<number> {
  const worker = workerExecutablePath()
  return terminateMatchingNow((row) => isIotaWorker(row, worker))
}

export interface IotaProcessSnapshot {
  appPid: number | null
  workers: Array<{ pid: number; command: string }>
  workerCount: number
  capturedAt: number
}

export async function iotaProcessSnapshot(): Promise<IotaProcessSnapshot> {
  const rows = await processes()
  const app = appExecutablePath()
  const worker = workerExecutablePath()
  const workers = [...rows.values()]
    .filter((row) => isIotaWorker(row, worker))
    .map(({ pid, command }) => ({ pid, command }))
    .sort((a, b) => a.pid - b.pid)
  return {
    appPid: [...rows.values()].find((row) => row.command === app)?.pid ?? null,
    workers,
    workerCount: workers.length,
    capturedAt: Date.now() / 1000,
  }
}

// 强制结束经过校验的 IOTA main_pool 及其 worker 子进程，等价于针对其 PID 集合执行 pkill。
export async function killIotaWorkersNow(): Promise<number> {
  const worker = workerExecutablePath()
  const snapshot = await processes()
  const targets = [...snapshot].filter(([, row]) => isIotaWorker(row, worker))
  const fresh = await processes()
  let killed = 0
  for (const [pid, row] of targets) {
    if (fresh.get(pid)?.command !== row.command) continue
    await signal(pid, 'SIGKILL')
    killed += 1
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const current = await processes()
    if (!targets.some(([pid, row]) => current.get(pid)?.command === row.command)) return killed
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('main_pool 进程未能全部结束')
}

// App 已退出时清理所有可确认属于它的 main_pool 及其 multiprocessing 子进程。
export async function terminateOrphanedIotaWorkers(rows: Map<number, ProcessRow>): Promise<number> {
  const orphans = orphanedIotaWorkers(rows)
  await terminateTargets(new Map([...orphans].map(([pid, row]) => [pid, row.command])), '残留 IOTA main_pool 未能退出,未启动新的 App')
  return orphans.size
}

export { INTERVAL_SEC }
