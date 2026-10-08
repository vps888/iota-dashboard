import { execFile } from 'node:child_process'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { APP_BUNDLE_CANDIDATES, LOGS_DIR } from './paths.js'

const INTERVAL_SEC = 30
const GRACE_SEC = 300
const COOLDOWN_SEC = 900

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
  trainingState: string | null
  trainingAt: number | null
  exitCode: number | null
  exitedAt: number | null
  quitAt: number | null
  fatal: boolean
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

export async function logRecords(): Promise<LogRecord[]> {
  const records: LogRecord[] = []
  if (!existsSync(LOGS_DIR)) return records
  for (const kind of ['main', 'cli'] as const) {
    const files = (await readdir(LOGS_DIR))
      .filter((name) => name.includes(`-${kind}`) && name.endsWith('.log'))
      .map((name) => `${LOGS_DIR}/${name}`)
    const withMtime = await Promise.all(files.map(async (f) => ({ f, mtime: (await stat(f)).mtimeMs })))
    withMtime.sort((a, b) => b.mtime - a.mtime)
    for (const { f } of withMtime.slice(0, 3)) {
      const text = await tail(f, 512 * 1024).catch(() => '')
      for (const line of text.split('\n')) {
        const match = STAMP_RE.exec(line)
        if (match) {
          const t = Date.parse(match[1]) / 1000
          if (Number.isFinite(t)) records.push({ t, line })
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
    trainingState: null,
    trainingAt: null,
    exitCode: null,
    exitedAt: null,
    quitAt: null,
    fatal: false,
  }
}

export function parseLogs(records: LogRecord[], previous: Partial<GuardianState>): Evidence {
  const starts = records.filter((r) => r.line.includes('[iota-cli runIotaCli] Connecting to CHANNEL')).map((r) => r.t)
  const started = starts.length > 0 ? Math.max(...starts) : (previous.sessionStartedAt ?? 0)
  const result = emptyEvidence(started)
  // 日志轮转跨天时,仅同一矿机会话的证据沿用
  if (started === previous.sessionStartedAt) {
    Object.assign(result, {
      queuePosition: previous.queuePosition ?? null,
      queueUpdatedAt: previous.queueUpdatedAt ?? null,
      queueStatus: previous.queueStatus ?? null,
      trainingState: previous.trainingState ?? null,
      trainingAt: previous.trainingAt ?? null,
      exitCode: previous.exitCode ?? null,
      exitedAt: previous.exitedAt ?? null,
      quitAt: previous.quitAt ?? null,
      fatal: previous.fatal ?? false,
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
      if (status) {
        result.queueStatus = status[1]
        result.queuePosition = position ? Number(position[1]) : null
        result.queueUpdatedAt = t
      }
    }
    const state = /training\.state accepted \{ state: '([^']+)'/.exec(line)
    if (state) {
      result.trainingState = state[1]
      if (state[1] === 'training' || state[1] === 'training_tick') {
        result.trainingAt = t
      } else if (state[1] === 'resetting' || state[1] === 'waiting_training') {
        result.trainingAt = null
      }
    }
    if (line.includes('Starting FORWARD pass') || line.includes('after training forward pass')) {
      result.trainingAt = t
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
  }
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
): { status: StatusKind; description: string; bad: boolean } {
  const started = evidence.sessionStartedAt
  if (!started && !minerAlive) {
    return { status: 'paused', description: '尚未启动过矿工;先打开 IOTA 并点击 Start training', bad: false }
  }
  if (evidence.quitAt && !appPid) {
    return { status: 'paused', description: '应用正常退出,保留手动停止意图', bad: false }
  }
  if (evidence.exitedAt && evidence.exitCode === 0 && !minerAlive) {
    return { status: 'paused', description: '矿工正常停止,等待手动启动或原有定时安排', bad: false }
  }
  if (appPid && now - started < GRACE_SEC) {
    const connected = Boolean(control?.connected && control.expectedHostPid === appPid)
    if (!connected) {
      return { status: 'starting', description: '矿工启动中,五分钟宽限期内不重启', bad: false }
    }
  }
  if (!appPid) {
    return { status: 'abnormal', description: 'IOTA 主程序不在运行', bad: true }
  }
  if (!minerAlive) {
    return { status: 'abnormal', description: '矿工进程已退出', bad: true }
  }
  if (!control?.ok) {
    return { status: 'abnormal', description: '本地矿工控制服务不可访问', bad: true }
  }
  if (control.expectedHostPid !== appPid || !control.connected) {
    return { status: 'abnormal', description: '矿工与桌面程序的控制连接断开', bad: true }
  }
  if (evidence.trainingAt && now - evidence.trainingAt < 300) {
    return { status: 'training', description: '最近五分钟有实际训练活动', bad: false }
  }
  if (evidence.queueStatus === 'queued') {
    const stale = now - (evidence.queueUpdatedAt ?? 0) > 900
    const base = evidence.queuePosition !== null ? `官方排队第 ${evidence.queuePosition} 位` : '等待官方分配训练任务'
    return { status: 'queued', description: base + (stale ? ';位置超过十五分钟未更新,暂不重启以免丢失队列' : ''), bad: false }
  }
  if (now - evidence.lastActivityAt > 1800) {
    return { status: 'abnormal', description: '矿工三十分钟没有任何活动,且未处于排队状态', bad: true }
  }
  return { status: 'waiting', description: '控制连接正常,等待注册、模型准备或训练任务', bad: false }
}

export interface NoidControlState {
  enabled: boolean
  mode: 'training' | 'default' | 'disabled' | 'unmanaged' | 'error'
  running: boolean | null
  cpuDuty: number | null
  gpuDuty: number | null
  cpuRate: number | null
  gpuRate: number | null
  accepted: number | null
  rejected: number | null
  stale: number | null
  error: string | null
  updatedAt: string
}

export interface GuardianState {
  sessionStartedAt: number
  lastActivityAt: number
  queuePosition: number | null
  queueUpdatedAt: number | null
  queueStatus: string | null
  trainingState: string | null
  trainingAt: number | null
  exitCode: number | null
  exitedAt: number | null
  quitAt: number | null
  fatal: boolean
  updatedAt: string
  status: StatusKind
  description: string
  appPid: number | null
  minerAlive: boolean
  controlConnected: boolean
  badChecks: number
  lastRestartAt: number | null
  restartHistory: number[]
  recoveryNote: string | null
  agentStartedAt: number
  totalRestarts: number
  noidControl?: NoidControlState | null
}

export function decision(state: GuardianState, now: number): 'restart' | string | null {
  if (state.badChecks < 3) return null
  const history = (state.restartHistory ?? []).filter((t) => now - t < 3600)
  if (history.length >= 3) return '小时重启上限已达三次,等待退避恢复'
  if (state.lastRestartAt && now - state.lastRestartAt < COOLDOWN_SEC) return '重启后十五分钟退避期内'
  return 'restart'
}

async function signal(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

// 终止前用 ps 重核命令行,防止 PID 复用误杀无关进程
export async function terminateIota(rows: Map<number, ProcessRow>): Promise<void> {
  const app = appExecutablePath()
  const worker = workerExecutablePath()
  const targets = new Map<number, string>()
  for (const [pid, row] of rows) {
    if (row.command === app || row.command.startsWith(worker) || row.command.startsWith('main_pool:ai.macrocosmos.iota.tah.worker')) {
      targets.set(pid, row.command)
    }
  }
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
  throw new Error('IOTA 进程未能退出,未启动重复实例')
}

export { INTERVAL_SEC }
