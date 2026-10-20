#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { LOCK_PATH } from './paths.js'
import { readState, saveState, event, clockString } from './state.js'
import {
  INTERVAL_SEC, processes, logRecords, parseLogs, health, classify,
  orphanedIotaWorkers, appExecutablePath, workerExecutablePath, type GuardianState,
} from './guardian.js'
import { startOptimized, appInstalled, isManagedRelayCommand, inspectRelayPort } from './launcher.js'
import { fanoutAgentAlert, loadAgentConfig } from './feishu-alert.js'
import { installLaunchAgent, installFeishuLaunchAgent, stopFeishuLaunchAgent, launchAgentStatus } from './launchagent.js'
import { runFeishuDiscovery, runFeishuBot, loadFeishuConfig, configureFeishuCredentials } from './feishu.js'
import { homedir } from 'node:os'
import { guardianAlerts, confirmedAlerts } from './guardian-alerts.js'
import { detectLocalMinerIds } from './identity.js'

const AGENT_VERSION = '0.2.12'

function usage(): void {
  console.log(`ma ${AGENT_VERSION} - IOTA Train at Home 本地守护与飞书控制

用法:
  ma install              设置登录后自动运行（守护和已配对的飞书机器人）
  ma stop                 停止 IOTA 与 main_pool（守护服务继续运行）
  ma status               查看 IOTA 与监控服务状态
  ma start                启动 IOTA（已运行时不重复启动）
  ma feishu setup         交互配置飞书应用凭据并自动发现本机 Miner ID
  ma alert add <chat_id>  将进程异常告警也推送到指定飞书群
  ma miner list           列出自动发现的本机 Miner ID
  ma miner select <序号>  选择用于飞书查询的 Miner ID
  ma feishu connect       自动配对飞书会话与当前用户
  ma feishu restart       重启飞书后台服务（重新加载当前安装版本）
  ma feishu service       运行飞书机器人后台服务
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

async function poll(previous: Partial<GuardianState>, agentStartedAt: number): Promise<{ state: GuardianState; rows: Awaited<ReturnType<typeof processes>> }> {
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
  const relayListeners = await inspectRelayPort().catch(() => [])
  const relayListener = relayListeners.find((listener) => isManagedRelayCommand(listener.command))
  const classified = classify(evidence, appPid, minerAlive, control, now)
  const status = classified.status
  const description = classified.description
  const state: GuardianState = {
    ...evidence,
    orphanedWorkerCount: orphanedWorkers.size,
    updatedAt: clockString(now),
    status,
    description,
    appPid,
    relayPid: relayListener?.pid ?? null,
    port18010: relayListeners,
    minerAlive,
    controlConnected: Boolean(control?.connected),
    agentStartedAt,
  }
  return { state, rows }
}

function display(state: Partial<GuardianState>): void {
  console.log('更新时间:', state.updatedAt ?? '尚未检查')
  console.log('当前状态:', state.description ?? '未知')
  console.log('控制连接:', state.controlConnected ? '正常' : '未连接')
  if (state.relayPid !== undefined) console.log('本地中继:', state.relayPid ? `运行中（PID ${state.relayPid}）` : '未运行')
  if (state.port18010?.length) console.log('18010 端口监听:', state.port18010.map((p) => `PID ${p.pid} ${isManagedRelayCommand(p.command) ? '(ma 中继)' : '(其他程序)'}: ${p.command}`).join('；'))
  if (state.queueUpdatedAt) console.log('队列更新时间:', clockString(state.queueUpdatedAt))

}

async function runGuardian(once: boolean): Promise<void> {
  if (!appInstalled()) fail('找不到官方 IOTA 应用。请先把 IOTA Train at Home.app 放进"应用程序"文件夹。')
  acquireLock()
  const previous = await readState<GuardianState>()
  const agentStartedAt = previous.agentStartedAt ?? Date.now() / 1000
  if (!once) await event('守护启动：每 30 秒检查 IOTA 进程、控制连接和日志；异常只发飞书告警，不自动重启。')

  let previousAlertKeys = new Set<string>()
  while (true) {
    try {
      const { state } = await poll(previous, agentStartedAt)
      if (!once) {
        const observedAlerts = guardianAlerts(state, Date.now() / 1000)
        const activeAlerts = confirmedAlerts(observedAlerts, previousAlertKeys)
        previousAlertKeys = new Set(observedAlerts.map((alert) => alert.key))
        if ((state.orphanedWorkerCount ?? 0) > 0) {
          const key = `orphaned-workers:${state.orphanedWorkerCount}`
          activeAlerts.push({ key, message: `IOTA 残留进程告警：检测到 ${state.orphanedWorkerCount} 个 main_pool 进程，主程序当前未运行。未自动重启；请检查后决定是否手动处理。` })
        }
        const alertStatePath = `${LOCK_PATH}.alerts.json`
        let previouslyActive = new Set<string>()
        try { previouslyActive = new Set(JSON.parse(readFileSync(alertStatePath, 'utf8')) as string[]) } catch {}
        const activeKeys = new Set([...previousAlertKeys, ...activeAlerts.map((alert) => alert.key)])
        const newlyActive = activeAlerts.filter((alert) => !previouslyActive.has(alert.key))
        if (newlyActive.length) {
          const feishu = await loadFeishuConfig()
          if (feishu?.chatId && feishu.allowedOpenIds.length > 0) {
            for (const alert of newlyActive) {
              try {
                await fanoutAgentAlert(feishu, await loadAgentConfig(), alert.message)
                await event(`异常告警已发送（仅告警，不自动重启）：${alert.key}；${state.description}`)
                previouslyActive.add(alert.key)
              } catch (error) {
                await event(`飞书异常告警发送失败：${alert.key}；${error instanceof Error ? error.message : String(error)}`)
              }
            }
          } else {
            await event(`异常告警未发送：飞书未配置；${newlyActive.map((alert) => alert.key).join(',')}`)
            // Avoid writing the same missing-configuration diagnostic every 30 seconds.
            for (const alert of newlyActive) previouslyActive.add(alert.key)
          }
        }
        // Persist only currently active incidents: recovery clears dedupe, so a later recurrence alerts again.
        const stillActive = [...previouslyActive].filter((key) => activeKeys.has(key))
        writeFileSync(alertStatePath, JSON.stringify(stillActive.slice(-100), null, 2) + '\n')
      }
      if (state.status !== previous.status || state.queuePosition !== previous.queuePosition || state.p2pAnomalyDetected !== previous.p2pAnomalyDetected) {
        await event(state.description)
      }
      await saveState(state)
      Object.assign(previous, state)
      if (once) {
        display(state)
        return
      }
    } catch (error) {
      previousAlertKeys.clear()
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
      console.log('ma 守护和已配对的飞书机器人已设为登录后自动运行。')
      break
    }
    case 'stop': {
      const { terminateIota } = await import('./guardian.js')
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
      const relayOwners = await inspectRelayPort().catch(() => [])
      console.log('本地中继:', relayOwners.some((p) => isManagedRelayCommand(p.command)) ? '运行中' : '未运行')
      if (relayOwners.length) console.log('18010 端口监听:', relayOwners.map((p) => `PID ${p.pid} ${isManagedRelayCommand(p.command) ? '(ma 中继)' : '(其他程序)'}: ${p.command}`).join('；'))
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
        if (!Number.isInteger(index) || index < 1 || index > identities.length) fail(`用法: ma miner select <序号 1-${identities.length}>`)
        const config = await loadFeishuConfig()
        if (!config) fail('请先运行 ma feishu setup')
        config.minerId = identities[index - 1]!.minerId
        const { atomicWriteJson } = await import('./fsutil.js')
        await atomicWriteJson(join(homedir(), '.miner-agent', 'feishu.json'), config)
        console.log(`已选择 Miner ID：${config.minerId}`)
      } else fail('用法: ma miner list | select <序号>')
      break
    }
    case 'alert': {
      const action = args[0]
      const targets = args.slice(1)
      const config = await loadAgentConfig()
      if (action === 'add') {
        if (targets.length !== 1 || !/^oc_[A-Za-z0-9]+$/.test(targets[0]!)) fail('用法: ma alert add <飞书群 chat_id>')
        const list = config.alertDestinations ?? []
        if (!list.some((item) => item.chatId === targets[0])) list.push({ chatId: targets[0]!, enabled: true })
        config.alertDestinations = list
        const { atomicWriteJson } = await import('./fsutil.js')
        await atomicWriteJson(join(homedir(), '.miner-agent', 'config.json'), config)
        console.log(`已添加告警群 ${targets[0]}；异常消息会推送到该群和已配对机器人私聊。`)
      } else if (action === 'list') {
        const destinations = config.alertDestinations ?? []
        if (!destinations.length) console.log('尚未配置额外告警群。使用 ma alert add <chat_id> 添加。')
        else destinations.forEach((target, index) => console.log(`${index + 1}. ${target.chatId} (${target.enabled === false ? '已停用' : '启用'})`))
      } else if (action === 'remove') {
        if (targets.length !== 1) fail('用法: ma alert remove <飞书群 chat_id>')
        config.alertDestinations = (config.alertDestinations ?? []).filter((item) => item.chatId !== targets[0])
        const { atomicWriteJson } = await import('./fsutil.js')
        await atomicWriteJson(join(homedir(), '.miner-agent', 'config.json'), config)
        console.log(`已移除告警群 ${targets[0]}。`)
      } else fail('用法: ma alert add <chat_id> | list | remove <chat_id>')
      break
    }
    case 'feishu': {
      const [action, ...feishuArgs] = args
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
          if (identities.length > 1) console.log('检测到多个本地钱包时，可用 ma miner select <序号> 切换。')
          console.log('下一步运行 ma feishu connect，并在飞书中给机器人发任意单聊消息完成配对。')
        } finally { terminal.close() }
      } else if (action === 'connect') {
        await runFeishuDiscovery()
      } else if (action === 'restart') {
        const feishu = await loadFeishuConfig()
        if (!feishu?.chatId || feishu.allowedOpenIds.length === 0) fail('飞书未完成配对；先运行 ma feishu connect。')
        await stopFeishuLaunchAgent()
        await new Promise((resolve) => setTimeout(resolve, 1000))
        await installFeishuLaunchAgent()
        console.log('飞书后台服务已重启并重新加载当前 ma 版本；IOTA 未重启。')
      } else if (action === 'service' || (action === 'run' && feishuArgs.includes('service'))) {
        const config = await loadFeishuConfig()
        if (!config) fail('请先运行 ma feishu setup')
        await runFeishuBot(config.minerId)
      } else fail('用法: ma feishu setup | connect | restart')
      break
    }
    default:
      usage()
      process.exit(command ? 1 : 0)
  }
}

await main()
