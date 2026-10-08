#!/usr/bin/env node
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { validateMinerId } from './ss58.js'
import { LOCK_PATH } from './paths.js'
import { loadConfig, updateConfig } from './config.js'
import { readState, saveState, event, clockString } from './state.js'
import {
  INTERVAL_SEC, processes, logRecords, parseLogs, health, classify, decision,
  terminateIota, appExecutablePath, workerExecutablePath, type GuardianState,
} from './guardian.js'
import { startOptimized, appInstalled } from './launcher.js'
import { installLaunchAgent, uninstallLaunchAgent } from './launchagent.js'
import { createReporter, ReportSink, AGENT_VERSION, currentOs, type ReportPayload } from './reporter.js'

function usage(): void {
  console.log(`iota-agent ${AGENT_VERSION} - IOTA Train at Home 本地守护与状态上报

用法:
  iota-agent install              安装登录后自动运行的 LaunchAgent 守护
  iota-agent uninstall            停止并移除 LaunchAgent 守护
  iota-agent run [--once]         运行守护循环(--once 只检查一轮,不重启)
  iota-agent status               显示最近一次守护结果
  iota-agent start                优化启动:先起本地中继再拉起官方应用
  iota-agent report --enable --token <t> --url <仪表盘地址> --miner <MinerID>
                                  启用状态上报(默认关闭)
  iota-agent report --disable     停用状态上报`)
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
  const minerAlive = [...rows.values()].some((row) => row.command.startsWith('main_pool:ai.macrocosmos.iota.tah.worker') || row.command.startsWith(worker))
  const evidence = parseLogs(await logRecords(), previous)
  const control = await health()
  const { status, description, bad } = classify(evidence, appPid, minerAlive, control, now)
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
    recoveryNote: null,
    agentStartedAt,
    totalRestarts,
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
}

async function runGuardian(once: boolean): Promise<void> {
  if (!appInstalled()) fail('找不到官方 IOTA 应用。请先把 IOTA Train at Home.app 放进"应用程序"文件夹。')
  acquireLock()
  const previous = await readState<GuardianState>()
  const agentStartedAt = previous.agentStartedAt ?? Date.now() / 1000
  let totalRestarts = previous.totalRestarts ?? 0
  if (!once) await event('守护启动:每三十秒检查;连续三次异常才重启;十五分钟退避;每小时最多三次')

  while (true) {
    try {
      // 每轮重读配置,让 report --enable/--disable 无需重启守护即生效
      const config = await loadConfig()
      const sink = new ReportSink(config ? createReporter(config) : null, event)
      const { state, rows } = await poll(previous, agentStartedAt, totalRestarts)
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
      if (state.status !== previous.status || state.queuePosition !== previous.queuePosition) {
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
      // 检查失败不等于矿工失败:监控出错时绝不重启
      await event(`监控检查失败:${error instanceof Error ? error.message : String(error)};本轮不执行重启`)
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
      console.log('如需状态上报,运行 iota-agent report --enable --token <t> --url <仪表盘地址> --miner <MinerID>。')
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
        console.log('尚未运行过守护。先运行 iota-agent run 或 iota-agent install。')
        break
      }
      display(state)
      break
    }
    case 'start':
      if (!appInstalled()) fail('找不到官方 IOTA 应用。请先把 IOTA Train at Home.app 放进"应用程序"文件夹。')
      await startOptimized()
      break
    case 'report': {
      if (args.includes('--disable')) {
        await updateConfig({ reportEnabled: false })
        console.log('已停用状态上报。')
        break
      }
      if (!args.includes('--enable')) fail('用法:iota-agent report --enable --token <t> --url <仪表盘地址> --miner <MinerID>,或 --disable')
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
