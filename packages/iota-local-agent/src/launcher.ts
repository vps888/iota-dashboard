import { spawn } from 'node:child_process'
import net from 'node:net'
import { open, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AGENT_DIR } from './paths.js'
const RELAY_LOG_PATH = `${AGENT_DIR}/relay.log`
const LAUNCH_LOG_PATH = `${AGENT_DIR}/optimized-launch.log`
const RELAY_PID_PATH = `${AGENT_DIR}/relay.pid`
import { appExecutablePath, execFileText, processes, terminateOrphanedIotaWorkers } from './guardian.js'
import { RELAY_PORT } from './relay.js'

const THREAD_ENV_KEYS = ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'TOKENIZERS_PARALLELISM']

function relayScriptPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return `${here}relay-entry.js`
}

async function relayCommand(pid: number): Promise<string | null> {
  try {
    const command = await execFileText('ps', ['-p', String(pid), '-o', 'command='])
    return command.trim() || null
  } catch {
    return null
  }
}

export function isManagedRelayCommand(command: string | null): boolean {
  return Boolean(command && /(?:^|\/)relay-entry\.js(?:\s|$)/.test(command))
}

function isManagedRelay(command: string | null): boolean { return isManagedRelayCommand(command) }

async function listenerPids(port: number): Promise<number[]> {
  try {
    const output = await execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    return [...new Set(output.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))]
  } catch {
    return []
  }
}

async function removeDeadRelayPid(): Promise<void> {
  try {
    const pid = Number((await readFile(RELAY_PID_PATH, 'utf8')).trim())
    if (!Number.isInteger(pid) || pid <= 0) return
    const command = await relayCommand(pid)
    if (isManagedRelay(command)) {
      try { process.kill(pid, 'SIGTERM') } catch { /* process already exited */ }
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && isManagedRelay(await relayCommand(pid))) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  } catch {
    // A missing or stale pid file is safe; never signal a process we cannot verify.
  }
}

export async function inspectRelayPort(port = RELAY_PORT): Promise<Array<{ pid: number; command: string }>> {
  const pids = await listenerPids(port)
  return Promise.all(pids.map(async (pid) => ({ pid, command: (await relayCommand(pid)) ?? '命令行不可读取' })))
}

async function adoptExistingRelay(port: number): Promise<boolean> {
  const pids = await listenerPids(port)
  if (pids.length === 0) return false
  const listeners = await Promise.all(pids.map(async (pid) => ({ pid, command: await relayCommand(pid) })))
  const relay = listeners.find((item) => isManagedRelay(item.command))
  if (relay) {
    await writeFile(RELAY_PID_PATH, String(relay.pid))
    console.log(`复用已运行的 miner-agent 本地中继（PID ${relay.pid}）。`)
    return true
  }
  const owner = listeners.map(({ pid, command }) => `PID ${pid}: ${command ?? '命令不可读'}`).join('; ')
  throw new Error(`本地端口 ${port} 被其他程序占用，未结束未知进程：${owner}`)
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(port, '127.0.0.1')
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

export async function startOptimized(): Promise<void> {
  const app = appExecutablePath()
  const rows = await processes()
  const appRunning = [...rows.values()].some((row) => row.command === app)
  if (appRunning) {
    console.log('IOTA 已在运行,不启动重复实例。需要切换到优化启动时,请先从 IOTA 菜单退出,再运行此启动器。')
    return
  }

  const cleaned = await terminateOrphanedIotaWorkers(rows)
  if (cleaned > 0) console.log(`已清理 ${cleaned} 个 IOTA main_pool 残留进程。`)

  const relayReady = await adoptExistingRelay(RELAY_PORT)
  if (!relayReady) {
    await removeDeadRelayPid()
    if (await portInUse(RELAY_PORT)) {
      throw new Error(`本地端口 ${RELAY_PORT} 仍被占用，未启动 IOTA。请运行 miner-agent status 并检查占用进程。`)
    }
    const log = await open(RELAY_LOG_PATH, 'a')
    const relay = spawn(process.execPath, [relayScriptPath()], {
      stdio: ['ignore', log.fd, log.fd],
      detached: true,
    })
    relay.unref()
    await writeFile(RELAY_PID_PATH, String(relay.pid))
    if (!(await waitForPort(RELAY_PORT, 5000)) || relay.exitCode !== null) {
      throw new Error('本地等待服务未就绪;未启动 IOTA。')
    }
  }

  const env: Record<string, string | undefined> = { ...process.env, MACROCOSMOS_WS_URL: `ws://127.0.0.1:${RELAY_PORT}/ws` }
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'rsync_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'RSYNC_PROXY', 'GIT_PROXY_COMMAND', 'npm_config_proxy', 'NPM_CONFIG_PROXY']) delete env[key]
  // 保留官方默认线程设置:限制线程数的实验未能修复启动问题
  for (const key of THREAD_ENV_KEYS) delete env[key]
  const log = await open(LAUNCH_LOG_PATH, 'a')
  const child = spawn(app, [], { stdio: ['ignore', log.fd, log.fd], detached: true, env })
  child.unref()
  console.log('已启动官方 IOTA,本地控制连接将等待真实矿工就绪。')
}

export function appInstalled(): boolean {
  return existsSync(appExecutablePath())
}
