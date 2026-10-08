import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { NOID_APP_CANDIDATES, NOID_CONTROL_SOCKET_PATH } from './paths.js'
import type { AgentConfig } from './config.js'
import type { NoidControlState, ProcessRow, StatusKind } from './guardian.js'

export interface NoidDutyTarget {
  mode: 'training' | 'default'
  cpuDuty: number
  gpuDuty: number
}

interface NoidResponse {
  ok: boolean
  running?: boolean
  cpuDuty?: number
  gpuDuty?: number
  cpuRate?: number
  gpuRate?: number
  accepted?: number
  rejected?: number
  stale?: number
  error?: string
}

const DEFAULT_TARGET: NoidDutyTarget = { mode: 'default', cpuDuty: 100, gpuDuty: 70 }
const TRAINING_TARGET: NoidDutyTarget = { mode: 'training', cpuDuty: 10, gpuDuty: 10 }
const CONTROL_TIMEOUT_MS = 2_000
const START_TIMEOUT_MS = 15_000

export function targetForIotaStatus(status: StatusKind | null | undefined): NoidDutyTarget {
  return status === 'training' ? TRAINING_TARGET : DEFAULT_TARGET
}

export function requestNoid(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<NoidResponse> {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      rejectRequest(error)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error('NOID control request timed out')))
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 8192) return fail(new Error('NOID control response too large'))
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as NoidResponse
        if (response.ok !== true) return fail(new Error(response.error ?? 'NOID control command failed'))
        settled = true
        socket.end()
        resolveRequest(response)
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid NOID control response'))
      }
    })
    socket.once('end', () => {
      if (!settled) fail(new Error('NOID control closed without a response'))
    })
    socket.once('error', (error) => fail(error))
  })
}

function noidProcesses(rows: Map<number, ProcessRow>): ProcessRow[] {
  return [...rows.values()].filter(({ command }) =>
    command.includes('/NOID Miner.app/Contents/MacOS/NOIDMiner') ||
    /\/Contents\/Resources\/miner\/bin\/noid-(?:cpu|metal)(?:\s|$)/.test(command),
  )
}

function appPath(config: AgentConfig): string | null {
  if (config.noidAppPath) {
    const configured = isAbsolute(config.noidAppPath) ? config.noidAppPath : resolve(config.noidAppPath)
    return existsSync(join(configured, 'Contents', 'MacOS', 'NOIDMiner')) ? configured : null
  }
  return NOID_APP_CANDIDATES.find((candidate) => existsSync(join(candidate, 'Contents', 'MacOS', 'NOIDMiner'))) ?? null
}

function openNoid(app: string, target: NoidDutyTarget): Promise<void> {
  return new Promise((resolveOpen, rejectOpen) => {
    execFile('/usr/bin/open', [
      '-a', app,
      '--args',
      '--resume-both',
      `--agent-cpu-duty=${target.cpuDuty}`,
      `--agent-gpu-duty=${target.gpuDuty}`,
    ], (error) => error ? rejectOpen(error) : resolveOpen())
  })
}

async function waitForControl(path: string): Promise<NoidResponse> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let lastError: Error = new Error('NOID control socket did not start')
  while (Date.now() < deadline) {
    try {
      return await requestNoid(path, { command: 'status' }, 800)
    } catch (error) {
      lastError = error instanceof Error ? error : lastError
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    }
  }
  throw lastError
}

function resultState(target: NoidDutyTarget, response: NoidResponse, error: string | null = null): NoidControlState {
  return {
    enabled: true,
    mode: error ? 'error' : target.mode,
    running: typeof response.running === 'boolean' ? response.running : null,
    cpuDuty: typeof response.cpuDuty === 'number' ? response.cpuDuty : null,
    gpuDuty: typeof response.gpuDuty === 'number' ? response.gpuDuty : null,
    cpuRate: typeof response.cpuRate === 'number' ? response.cpuRate : null,
    gpuRate: typeof response.gpuRate === 'number' ? response.gpuRate : null,
    accepted: typeof response.accepted === 'number' ? response.accepted : null,
    rejected: typeof response.rejected === 'number' ? response.rejected : null,
    stale: typeof response.stale === 'number' ? response.stale : null,
    error,
    updatedAt: new Date().toISOString(),
  }
}

function errorState(message: string): NoidControlState {
  return {
    enabled: true,
    mode: 'error',
    running: null,
    cpuDuty: null,
    gpuDuty: null,
    cpuRate: null,
    gpuRate: null,
    accepted: null,
    rejected: null,
    stale: null,
    error: message,
    updatedAt: new Date().toISOString(),
  }
}

export async function reconcileNoid(
  status: StatusKind | null | undefined,
  config: AgentConfig,
  rows: Map<number, ProcessRow> | null,
  socketPath = NOID_CONTROL_SOCKET_PATH,
): Promise<NoidControlState> {
  const target = targetForIotaStatus(status)
  let connected = false
  let response: NoidResponse | null = null
  try {
    response = await requestNoid(socketPath, { command: 'status' })
    connected = true
  } catch {
    if (!rows) return errorState('无法枚举进程，拒绝启动 NOID 以避免重复挖矿')
    if (noidProcesses(rows).length > 0) {
      return { ...errorState('检测到无本地控制接口的 NOID 进程；为避免双挖，不自动启动第二个实例'), mode: 'unmanaged', running: true }
    }
    const app = appPath(config)
    if (!app) return errorState('找不到定制版 NOID Miner.app；请安装到 /Applications 或配置 noidAppPath')
    await openNoid(app, target)
    response = await waitForControl(socketPath)
    connected = true
  }

  if (!connected || !response) return errorState('NOID control connection unavailable')
  await requestNoid(socketPath, { command: 'setDuty', cpuDuty: target.cpuDuty, gpuDuty: target.gpuDuty })
  const running = await requestNoid(socketPath, { command: 'ensureRunning' })
  if (running.running !== true) return resultState(target, running, 'NOID 未进入运行状态，请检查收款地址和矿工窗口')
  const state = resultState(target, running)
  if (state.cpuDuty !== target.cpuDuty || state.gpuDuty !== target.gpuDuty) return resultState(target, running, 'NOID 未应用请求的 CPU/GPU 占空比')
  return state
}

export async function resetNoidDuty(
  rows: Map<number, ProcessRow> | null,
  socketPath = NOID_CONTROL_SOCKET_PATH,
): Promise<boolean> {
  try {
    await requestNoid(socketPath, { command: 'resetDuty' })
    return true
  } catch {
    if (rows && noidProcesses(rows).length > 0) throw new Error('NOID 进程无法访问控制 socket，未修改其状态')
    return false
  }
}
