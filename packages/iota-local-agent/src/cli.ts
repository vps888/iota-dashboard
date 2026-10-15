#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { validateMinerId } from './ss58.js'
import { LOCK_PATH } from './paths.js'
import { readState, saveState, event, clockString } from './state.js'
import {
  INTERVAL_SEC, processes, logRecords, parseLogs, health, classify, decision,
  terminateIota, orphanedIotaWorkers, appExecutablePath, workerExecutablePath, type GuardianState,
} from './guardian.js'
import { startOptimized, appInstalled } from './launcher.js'
import { installLaunchAgent, installFeishuLaunchAgent, launchAgentStatus } from './launchagent.js'
import { runFeishuDiscovery, loadFeishuConfig, configureFeishuCredentials } from './feishu.js'
import { homedir } from 'node:os'
import { detectLocalMinerIds } from './identity.js'

const AGENT_VERSION = '0.2.0'

function usage(): void {
  console.log(`miner-agent ${AGENT_VERSION} - IOTA Train at Home 本地守护与飞书控制

用法:
  miner-agent install              设置登录后自动运行（守护和已配对的飞书机器人）
  miner-agent stop                 停止 IOTA 与 main_pool（守护服务继续运行）
  miner-agent status               查看 IOTA 与监控服务状态
  miner-agent start                启动 IOTA（已运行时不重复启动）
  miner-agent feishu setup         交互配置飞书应用凭据并自动发现本机 Miner ID
  miner-agent miner list           列出自动发现的本机 Miner ID
  miner-agent miner select <序号>  选择用于飞书查询的 Miner ID
  miner-agent feishu connect       自动配对飞书会话与当前用户
`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
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
  process.once('exit', () => { try { unlinkSync(LOCK_PATH) } catch {} })
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
      ? `发现 ${orphanedWorkers.size} 个残留 IOTA main_pool 进程;确认 App 已退出后,守护会先清理再启动`
      : evidence.p2pRestartRecommended ? '日志检测到相邻层 P2P 节点缺失;建议彻底退出 IOTA 并使用 miner-agent start 重启' : null,
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
      if (state.status !== previous.status || state.queuePosition !== previous.queuePosition || state.p2pRestartRecommended !== previous.p2pRestartRecommended) {
        await event(state.description)
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
      if (once) throw error
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000))
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'install': {
      if (!appInstalled()) fail('找不到官方 IOTA 应用。请先安装官方 IOTA Train at Home.app。')
      await installLaunchAgent()
      const feishu = await loadFeishuConfig()
      if (feishu?.chatId && feishu.allowedOpenIds.length) await installFeishuLaunchAgent()
      console.log('miner-agent 守护和已配对的飞书机器人已设为登录后自动运行。')
      break
    }
    case 'stop': {
      await terminateIota(await processes())
      console.log('IOTA 与 main_pool 已停止；守护和飞书机器人服务继续运行。')
      break
    }
    case 'run':
      await runGuardian(args.includes('--once'))
      break
    case 'status': {
      const state = await readState<GuardianState>()
      if (!state.updatedAt) console.log('本地监控状态：尚无记录')
      else display(state)
      const rows = await processes()
      const appPid = [...rows.values()].find((row) => row.command === appExecutablePath())?.pid
      console.log('IOTA 应用:', appPid ? `运行中（PID ${appPid}）` : '未运行')
      const services = await launchAgentStatus()
      console.log('守护服务:', services.guardian ? '运行中' : '已停止')
      console.log('飞书机器人:', services.feishu ? '运行中' : '已停止')
      break
    }
    case 'start': {
      if (!appInstalled()) fail('找不到官方 IOTA 应用。请先把 IOTA Train at Home.app 放进“应用程序”文件夹。')
      await startOptimized()
      console.log('IOTA 启动请求已发送（若已运行则不会启动重复实例）。')
      break
    }
    case 'miner': {
      const action = args[0]
      const scan = await detectLocalMinerIds()
      const identities = scan.identities
      if (action === 'list') {
        const current = await loadFeishuConfig()
        if (!identities.length) console.log('未发现本机 Miner ID。')
        else identities.forEach((item, index) => console.log(`${item.minerId === current?.minerId ? '*' : ' '} ${index + 1}. ${item.minerId}（${item.walletName}/${item.hotkeyName}；${item.source}）${item.minerId === scan.recommendedMinerId ? ' [当前 IOTA 日志匹配]' : ''}`))
      } else if (action === 'select') {
        const index = Number(args[1])
        if (!Number.isInteger(index) || index < 1 || index > identities.length) fail(`用法: miner-agent miner select <序号 1-${identities.length}>`)
        const config = await loadFeishuConfig()
        if (!config) fail('请先运行 miner-agent feishu setup')
        config.minerId = identities[index - 1]!.minerId
        const { atomicWriteJson } = await import('./fsutil.js')
        await atomicWriteJson(join(homedir(), '.miner-agent', 'feishu.json'), config)
        console.log(`已选择 Miner ID：${config.minerId}`)
      } else fail('用法: miner-agent miner list | select <序号>')
      break
    }
    case 'feishu': {
      const action = args[0]
      if (action === 'setup') {
        const readline = await import('node:readline/promises')
        const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
        try {
          const appId = await terminal.question('飞书 App ID: ')
          const appSecret = await terminal.question('飞书 App Secret: ')
          const identities = await configureFeishuCredentials(appId, appSecret)
          console.log('凭据已保存；自动发现的本机 Miner ID：')
          const configured = await loadFeishuConfig()
          for (const [index, identity] of identities.entries()) console.log(`${identity.minerId === configured?.minerId ? '*' : ' '} ${index + 1}. ${identity.minerId}（钱包 ${identity.walletName} / hotkey ${identity.hotkeyName}；来源：${identity.source}）`)
          if (identities.length > 1) console.log('检测到多个本地钱包时，可用 miner-agent miner select <序号> 切换。')
          console.log('下一步运行 miner-agent feishu connect，并在飞书中给机器人发任意单聊消息完成配对。')
        } finally { terminal.close() }
      } else if (action === 'connect') {
        await runFeishuDiscovery()
      } else fail('用法: miner-agent feishu setup | connect')
      break
    }
    default:
      usage()
      process.exit(command ? 1 : 0)
  }
}

await main()
