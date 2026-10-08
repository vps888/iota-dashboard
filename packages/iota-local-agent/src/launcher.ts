import { spawn } from 'node:child_process'
import net from 'node:net'
import { open, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RELAY_LOG_PATH, LAUNCH_LOG_PATH, RELAY_PID_PATH } from './paths.js'
import { appExecutablePath, execFileText, processes } from './guardian.js'
import { RELAY_PORT } from './relay.js'

const THREAD_ENV_KEYS = ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'TOKENIZERS_PARALLELISM']

function relayScriptPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return `${here}relay-entry.js`
}

async function relayAlreadyRunning(): Promise<boolean> {
  try {
    const pid = Number((await readFile(RELAY_PID_PATH, 'utf8')).trim())
    if (!Number.isFinite(pid)) return false
    const command = await execFileText('ps', ['-p', String(pid), '-o', 'command='])
    return command.includes('relay-entry.js')
  } catch {
    return false
  }
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

  if (!(await relayAlreadyRunning())) {
    if (await portInUse(RELAY_PORT)) {
      throw new Error('本地端口 18010 被其他程序占用;未启动 IOTA。')
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
