#!/usr/bin/env node
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { validateMinerId } from './ss58.js'
import { LOCK_PATH } from './paths.js'
import { loadConfig, updateConfig, type AgentConfig } from './config.js'
import { readState, saveState, event, clockString } from './state.js'
import {
  INTERVAL_SEC, processes, logRecords, parseLogs, health, classify, decision,
  terminateIota, orphanedIotaWorkers, appExecutablePath, workerExecutablePath, type GuardianState, type NoidControlState,
} from './guardian.js'
import { startOptimized, appInstalled } from './launcher.js'
import { installLaunchAgent, uninstallLaunchAgent } from './launchagent.js'
import { reconcileNoid, resetNoidDuty } from './noid-controller.js'
import { createReporter, ReportSink, AGENT_VERSION, currentOs, type ReportPayload } from './reporter.js'

function usage(): void {
  console.log(`miner-agent ${AGENT_VERSION} - IOTA Train at Home 本地守护与状态上报

用法:
  miner-agent install              安装登录后自动运行的 LaunchAgent 守护
  miner-agent uninstall            停止并移除 LaunchAgent 守护
  miner-agent run [--once]         运行守护循环(--once 只检查一轮,不重启)
  miner-agent status               显示最近一次守护结果
  miner-agent start                优化启动:先起本地中继再拉起官方应用
  miner-agent noid enable [--app <path>] 启用 NOID 自动启动与负载调度
  miner-agent noid disable         关闭调度并恢复 NOID 默认负载(不停止挖矿)
  miner-agent noid status           显示 NOID 调度配置与最近状态
  miner-agent report --enable --token <t> --url <仪表盘地址> --miner <MinerID>
                                  启用状态上报(默认关闭)
  miner-agent report --disable     停用状态上报`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

// lock 文件存 PID;持锁进程已死时可以偷锁
function acquireLock(): void {
  if (existsSync(LOCK_PATH)) {
    try {
      const pid = Number(readFileSync(LOCK_PATH, 'utf8').trim())
      process.kill(pid, 0)
      fail('守护已经运行,不创建重复实例')
    } catch {
      // 持锁进程不存在,偷锁
    }
  }
  writeFileSync(LOCK_PATH, `${process.pid}\n`)
}

async function poll(previous: Partial<GuardianState>, agentStartedAt: number, totalRestarts: number): Promise<{ state: GuardianState; rows: Awaited<ReturnType<typeof processes>> }> {
  const now = Date.now() / 1000
  const rows = await processes()
  const app = appExecutablePath()
  const worker = workerExecutablePath()
  const appPid = [...rows.values()].find((row) => row.command === app)?.pid ?? null
  const appRunning = [...rows.values()].some((row) => row.command === app)
  const orphanedWorkers = appRunning ? new Map() : orphanedIotaWorkers(rows)
  const minerAlive = [...rows.values()].some((row) => row.command.startsWith('main_pool:ai.macrocosmos.iota.tah.worker') || row.command.startsWith(worker))
  const evidence = parseLogs(await logRecords(), previous)
  const control = await health()
  const classified = classify(evidence, appPid, minerAlive, control, now)
  const status = classified.status
  const description = evidence.p2pRestartRecommended
    ? `${classified.description};检测到 P2P 节点缺失,建议彻底退出 IOTA 并通过 miner-agent start 清理残留进程后重启`
    : classified.description
  const bad = classified.bad
  const sameSession = evidence.sessionStartedAt === previous.sessionStartedAt
  const state: GuardianState = {
    ...evidence,
    updatedAt: clockString(now),
    status,
    description,
    appPid,
    minerAlive,
    controlConnected: Boolean(control?.connected),
    badChecks: bad ? ((sameSession ? (previous.badChecks ?? 0) : 0) + 1) : 0,
    lastRestartAt: previous.lastRestartAt ?? null,
    restartHistory: previous.restartHistory ?? [],
    recoveryNote: orphanedWorkers.size > 0
      ? `发现 ${orphanedWorkers.size} 个残留 main_pool 进程;确认 App 已退出后,miner-agent start 会先清理`
      : evidence.p2pRestartRecommended ? '日志检测到相邻层 P2P 节点缺失;建议彻底退出 IOTA 并使用 miner-agent start 重启' : null,
    agentStartedAt,
    totalRestarts,
    noidControl: previous.noidControl ?? null,
  }
  return { state, rows }
}

function display(state: Partial<GuardianState>): void {
  console.log('更新时间:', state.updatedAt ?? '尚未检查')
  console.log('当前状态:', state.description ?? '未知')
  console.log('控制连接:', state.controlConnected ? '正常' : '未连接')
  if (state.queueUpdatedAt) console.log('队列更新时间:', clockString(state.queueUpdatedAt))
  if (state.lastRestartAt) console.log('最近自动重启:', clockString(state.lastRestartAt))
  if (state.recoveryNote) console.log('恢复说明:', state.recoveryNote)
  if (state.noidControl?.enabled) {
    const target = state.noidControl.cpuDuty === null || state.noidControl.gpuDuty === null
      ? '负载未知'
      : `CPU ${state.noidControl.cpuDuty}% / GPU ${state.noidControl.gpuDuty}%`
    console.log('NOID 调度:', `${state.noidControl.mode}; ${target}${state.noidControl.error ? `; ${state.noidControl.error}` : ''}`)
  }
}

function noidChanged(previous: NoidControlState | null | undefined, next: NoidControlState): boolean {
  return !previous || previous.mode !== next.mode || previous.running !== next.running ||
    previous.cpuDuty !== next.cpuDuty || previous.gpuDuty !== next.gpuDuty || previous.error !== next.error
}

function noidEventMessage(state: NoidControlState): string {
  if (state.mode === 'training') return 'NOID 负载已降至 CPU/GPU 10%（IOTA 正在训练）'
  if (state.mode === 'default') return 'NOID 已恢复默认负载（IOTA 未处于训练状态）'
  if (state.mode === 'unmanaged') return `NOID 未接管：${state.error ?? '存在未受控进程'}`
  if (state.mode === 'disabled') return 'NOID 自动调度已关闭'
  return `NOID 调度异常：${state.error ?? '控制失败'}`
}

async function noidCommand(args: string[]): Promise<void> {
  const [action, ...options] = args
  if (action === 'enable') {
    const app = argValue(options, '--app')
    if (app && !existsSync(join(resolve(app), 'Contents', 'MacOS', 'NOIDMiner'))) fail('--app 必须指向 NOID Miner.app')
    await updateConfig({ noidManaged: true, ...(app ? { noidAppPath: resolve(app) } : {}) })
    console.log('NOID 自动调度已启用；正在运行的守护会在下一轮(最多 30 秒)应用策略。')
    return
  }
  if (action === 'disable') {
    await updateConfig({ noidManaged: false })
    console.log('NOID 自动调度已关闭；守护会恢复默认负载，不会停止矿工。')
    return
  }
  if (action === 'status') {
    const config = await loadConfig()
    const state = await readState<GuardianState>()
    console.log('自动调度:', config?.noidManaged ? '已启用' : '已关闭')
    console.log('应用路径:', config?.noidAppPath ?? '自动查找 /Applications/NOID Miner.app')
    console.log('最近状态:', state.noidControl?.mode ?? '尚无记录')
    if (state.noidControl?.error) console.log('说明:', state.noidControl.error)
    return
  }
  fail('用法:miner-agent noid enable [--app <path>] | disable | status')
}

async function runGuardian(once: boolean): Promise<void> {
  if (!appInstalled()) fail('找不到官方 IOTA 应用。请先把 IOTA Train at Home.app 放进"应用程序"文件夹。')
  acquireLock()
  const previous = await readState<GuardianState>()
  const agentStartedAt = previous.agentStartedAt ?? Date.now() / 1000
  let totalRestarts = previous.totalRestarts ?? 0
  if (!once) await event('守护启动:每三十秒检查;连续三次异常才重启;十五分钟退避;每小时最多三次')

  while (true) {
    let config: AgentConfig | null = null
    try {
      // 每轮重读配置,让 report 与 NOID 调度开关无需重启守护即生效
      config = await loadConfig()
      const sink = new ReportSink(config ? createReporter(config) : null, event)
      const { state, rows } = await poll(previous, agentStartedAt, totalRestarts)
      if (!once && config?.noidManaged) {
        let noid: NoidControlState
        try {
          noid = await reconcileNoid(state.status, config, rows)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await event(`NOID 控制失败，回退默认负载:${message}`)
          try {
            noid = await reconcileNoid(null, config, rows)
          } catch (fallbackError) {
            noid = {
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
              error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
              updatedAt: new Date().toISOString(),
            }
          }
        }
        state.noidControl = noid
        if (noidChanged(previous.noidControl, noid)) await event(noidEventMessage(noid))
      } else if (!once && previous.noidControl?.enabled) {
        let resetError: string | null = null
        try {
          await resetNoidDuty(rows)
        } catch (error) {
          resetError = error instanceof Error ? error.message : String(error)
        }
        const disabled: NoidControlState = {
          ...previous.noidControl,
          enabled: false,
          mode: resetError ? 'error' : 'disabled',
          cpuDuty: resetError ? previous.noidControl.cpuDuty : null,
          gpuDuty: resetError ? previous.noidControl.gpuDuty : null,
          error: resetError,
          updatedAt: new Date().toISOString(),
        }
        state.noidControl = disabled
        if (noidChanged(previous.noidControl, disabled)) await event(noidEventMessage(disabled))
      }
      const action = decision(state, Date.now() / 1000)
      state.recoveryNote = action === null || action === 'restart' ? null : action
      if (!once && action === 'restart') {
        const now = Date.now() / 1000
        state.lastRestartAt = now
        state.restartHistory = state.restartHistory.filter((t) => now - t < 3600).concat(now)
        state.badChecks = 0
        totalRestarts += 1
        state.totalRestarts = totalRestarts
        await saveState(state) // 先持久化限流计数,再做任何变更操作
        await event(`自动重启:${state.description}`)
        try {
          await terminateIota(rows)
          await startOptimized()
          state.recoveryNote = '已通过优化启动器重新启动,等待矿工就绪'
        } catch (error) {
          state.recoveryNote = `重启未完成:${error instanceof Error ? error.message : String(error)}`
          await event(state.recoveryNote)
        }
      }
      if (state.status !== previous.status || state.queuePosition !== previous.queuePosition || state.p2pRestartRecommended !== previous.p2pRestartRecommended) {
        await event(state.description)
      }
      {
        const payload: ReportPayload = {
          status: state.status,
          description: state.description,
          queuePosition: state.queuePosition,
          controlConnected: state.controlConnected,
          restarts: state.totalRestarts,
          uptimeSec: Math.floor(Date.now() / 1000 - state.agentStartedAt),
          reportedAt: Math.floor(Date.now() / 1000),
          os: currentOs(),
          agentVersion: AGENT_VERSION,
          noid: state.noidControl ? {
            mode: state.noidControl.mode,
            running: state.noidControl.running,
            cpuDuty: state.noidControl.cpuDuty,
            gpuDuty: state.noidControl.gpuDuty,
            cpuRate: state.noidControl.cpuRate,
            gpuRate: state.noidControl.gpuRate,
            accepted: state.noidControl.accepted,
            rejected: state.noidControl.rejected,
            stale: state.noidControl.stale,
          } : null,
        }
        await sink.submit(payload)
      }
      await saveState(state)
      Object.assign(previous, state)
      if (once) {
        display(state)
        return
      }
    } catch (error) {
      // 检查失败不等于矿工失败:监控出错时绝不重启 IOTA
      await event(`监控检查失败:${error instanceof Error ? error.message : String(error)};本轮不执行重启`)
      if (!once && config?.noidManaged) {
        try {
          const rows = await processes().catch(() => null)
          const noid = await reconcileNoid(null, config, rows)
          if (noidChanged(previous.noidControl, noid)) await event(noidEventMessage(noid))
          previous.noidControl = noid
          const saved = await readState<GuardianState>()
          await saveState({ ...saved, noidControl: noid })
        } catch (noidError) {
          await event(`NOID 默认负载回退失败:${noidError instanceof Error ? noidError.message : String(noidError)}`)
        }
      }
      if (once) throw error
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000))
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'install':
      if (!appInstalled()) fail('找不到官方 IOTA 应用。请先安装官方 IOTA Train at Home.app。')
      await installLaunchAgent()
      console.log('安装完成。守护已注册为登录后自动运行(每三十秒检查;连续三次本地异常才重启;正常排队不会被重启)。')
      console.log('如需状态上报,运行 miner-agent report --enable --token <t> --url <仪表盘地址> --miner <MinerID>。')
      break
    case 'uninstall':
      await uninstallLaunchAgent()
      console.log('已停止并移除后台守护;矿机保持当前运行状态。')
      break
    case 'run':
      await runGuardian(args.includes('--once'))
      break
    case 'status': {
      const state = await readState<GuardianState>()
      if (!state.updatedAt) {
        console.log('尚未运行过守护。先运行 miner-agent run 或 miner-agent install。')
        break
      }
      display(state)
      break
    }
    case 'start':
      if (!appInstalled()) fail('找不到官方 IOTA 应用。请先把 IOTA Train at Home.app 放进"应用程序"文件夹。')
      await startOptimized()
      break
    case 'noid':
      await noidCommand(args)
      break
    case 'report': {
      if (args.includes('--disable')) {
        await updateConfig({ reportEnabled: false })
        console.log('已停用状态上报。')
        break
      }
      if (!args.includes('--enable')) fail('用法:miner-agent report --enable --token <t> --url <仪表盘地址> --miner <MinerID>,或 --disable')
      const token = argValue(args, '--token')
      const url = argValue(args, '--url')
      const miner = argValue(args, '--miner')
      if (!token || !url || !miner) fail('缺少 --token / --url / --miner 参数')
      if (!validateMinerId(miner).valid) fail('Miner ID 格式无效(应为 SS58 hotkey)')
      try {
        new URL(url)
      } catch {
        fail('--url 必须是有效的 URL,例如 https://your-dashboard.pages.dev')
      }
      await updateConfig({ token, dashboardUrl: url, minerId: miner, reportEnabled: true })
      console.log('已启用状态上报:每三十秒向仪表盘发送脱敏状态(不含主机名、路径、日志内容)。')
      break
    }
    default:
      usage()
      process.exit(command ? 1 : 0)
  }
}

await main()
