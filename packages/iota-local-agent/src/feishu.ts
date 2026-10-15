import { Client, EventDispatcher, WSClient, type CardActionEvent } from '@larksuiteoapi/node-sdk'
import { readFile, readdir, stat, mkdir, chmod, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { appInstalled, startOptimized } from './launcher.js'
import { createOfficialClient } from './official.js'

import { appExecutablePath, classify, health, logRecords, parseLogs, processes, type GuardianState } from './guardian.js'
import { terminateIota } from './guardian.js'
import { readState, event } from './state.js'
import { AGENT_DIR } from './paths.js'
import { installFeishuLaunchAgent } from './launchagent.js'
import { validateMinerId } from './ss58.js'
import { detectLocalMinerIds, type LocalMinerIdentity } from './identity.js'

export interface FeishuCredentials { appId: string; appSecret: string; chatId: string; minerId: string; allowedOpenIds: string[]; speedtestRecoveryEnabled?: boolean }
const FEISHU_CONFIG_PATH = join(homedir(), '.miner-agent', 'feishu.json')
const LOW_SPEED = 1


export async function loadFeishuConfig(): Promise<FeishuCredentials | null> {
  try {
    const config = JSON.parse(await readFile(FEISHU_CONFIG_PATH, 'utf8')) as Partial<FeishuCredentials>
    if (typeof config.appId !== 'string' || typeof config.appSecret !== 'string' || typeof config.chatId !== 'string' || typeof config.minerId !== 'string' || !Array.isArray(config.allowedOpenIds)) return null
    return config as FeishuCredentials
  } catch { return null }
}

export async function configureFeishuCredentials(appId: string, appSecret: string, _minerId?: string): Promise<LocalMinerIdentity[]> {
  if (!appId.trim() || !appSecret.trim()) throw new Error('请提供有效的 App ID 和 App Secret')
  const detection = await detectLocalMinerIds()
  if (detection.identities.length === 0) throw new Error('没有自动发现本机 Miner ID。请确认 IOTA 钱包已配置，并存在本机 Bittensor 公钥文件。')
  await mkdir(dirname(FEISHU_CONFIG_PATH), { recursive: true })
  const current = await loadFeishuConfig()
  const unique = detection.identities
  const selected = unique.find((identity) => identity.minerId === current?.minerId) ?? unique.find((identity) => identity.minerId === detection.recommendedMinerId) ?? unique[0]!
  const next: FeishuCredentials = { appId: appId.trim(), appSecret: appSecret.trim(), minerId: selected.minerId, chatId: current?.chatId ?? '', allowedOpenIds: current?.allowedOpenIds ?? [], speedtestRecoveryEnabled: current?.speedtestRecoveryEnabled ?? true }
  await writeFile(FEISHU_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  await chmod(FEISHU_CONFIG_PATH, 0o600)
  return unique
}

export async function pairFeishuChat(chatId: string, allowedOpenIds: string[]): Promise<void> {
  const current = await loadFeishuConfig()
  if (!current) throw new Error('请先配置飞书 App ID、App Secret 和 Miner ID')
  const normalized = [...new Set(allowedOpenIds.map((value) => value.trim()).filter(Boolean))]
  if (!chatId.trim() || normalized.length === 0) throw new Error('chat_id 和至少一个允许操作的 open_id 不能为空')
  const next = { ...current, chatId: chatId.trim(), allowedOpenIds: normalized }
  await writeFile(FEISHU_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  await chmod(FEISHU_CONFIG_PATH, 0o600)
}


interface RecoveryState { lastSpeedtestAt: number; consecutiveLow: number; restarts: number; alerted: boolean }
const RECOVERY_STATE_PATH = join(AGENT_DIR, 'recovery.json')
async function readRecoveryState(): Promise<RecoveryState> {
  try { return JSON.parse(await readFile(RECOVERY_STATE_PATH, 'utf8')) as RecoveryState }
  catch { return { lastSpeedtestAt: 0, consecutiveLow: 0, restarts: 0, alerted: false } }
}
async function writeRecoveryState(value: RecoveryState): Promise<void> {
  await writeFile(RECOVERY_STATE_PATH, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await chmod(RECOVERY_STATE_PATH, 0o600)
}
async function newestCliLog(): Promise<string | null> {
  const files = (await readdir(join(homedir(), 'Library', 'Logs', 'IOTA Train at Home')).catch(() => []))
    .filter((name) => name.includes('-cli') && name.endsWith('.log'))
  const items = await Promise.all(files.map(async (name) => ({ path: join(homedir(), 'Library', 'Logs', 'IOTA Train at Home', name), mtime: (await stat(join(homedir(), 'Library', 'Logs', 'IOTA Train at Home', name)).catch(() => null))?.mtimeMs ?? 0 })))
  return items.sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null
}
async function latestSpeedtest(after: number): Promise<{ at: number; download: number; upload: number } | null> {
  const path = await newestCliLog()
  if (!path) return null
  const text = await readFile(path, 'utf8').catch(() => '')
  const results: { at: number; download: number; upload: number }[] = []
  for (const line of text.split('\n')) {
    const match = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\].*Speedtest completed with results:.*['\"]download_mbps['\"]:\s*([0-9.]+).*['\"]upload_mbps['\"]:\s*([0-9.]+)/.exec(line)
    if (!match) continue
    const at = Date.parse(match[1]!) / 1000
    if (at > after) results.push({ at, download: Number(match[2]), upload: Number(match[3]) })
  }
  return results.sort((a, b) => b.at - a.at)[0] ?? null
}
async function checkSpeedtestRecovery(client: Client, config: FeishuCredentials): Promise<void> {
  const state = await readRecoveryState()
  if (Date.now() / 1000 - state.lastSpeedtestAt < 10 * 60) return
  const result = await latestSpeedtest(state.lastSpeedtestAt)
  if (!result) return
  state.lastSpeedtestAt = result.at
  const low = result.download < 1 && result.upload < 1
  if (!low) { state.consecutiveLow = 0; state.restarts = 0; state.alerted = false; await writeRecoveryState(state); return }
  state.consecutiveLow += 1
  await event(`测速低于阈值：下载 ${result.download} Mbps，上传 ${result.upload} Mbps（连续 ${state.consecutiveLow} 次）`)
  if (state.restarts < 3) {
    state.restarts += 1
    await writeRecoveryState(state)
    await event(`测速低速自动恢复：第 ${state.restarts}/3 次重启`)
    try {
      await terminateIota(await processes())
      await new Promise((resolve) => setTimeout(resolve, 5000))
      await startOptimized()
      await event('测速低速恢复重启请求已提交')
    } catch (error) { await event(`测速低速恢复失败：${error instanceof Error ? error.message : String(error)}`) }
    return
  }
  if (!state.alerted) {
    state.alerted = true
    await writeRecoveryState(state)
    await sendText(client, config.chatId, `IOTA 网络测速告警：连续低速且自动重启 3 次后仍未恢复。最新下载 ${num(result.download, 2)} Mbps，上传 ${num(result.upload, 2)} Mbps。`)
    await event('低速告警已通过飞书机器人发送')
  }
}

function date(ts: number | null | undefined): string {
  return ts ? new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
}
function num(n: number | null | undefined, digits = 4): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—'
}

async function statusText(minerId: string): Promise<string> {
  const [rows, records, state, control] = await Promise.all([processes(), logRecords(), readState<GuardianState>(), health()])
  const appPath = appExecutablePath()
  const app = [...rows.values()].find((row) => row.command === appPath)
  const worker = [...rows.values()].filter((row) => row.command.startsWith(`${appPath.replace('/Contents/MacOS/IOTA Train at Home', '/Contents/Frameworks/iota-cli/main_pool')}`) || row.command.startsWith('main_pool:ai.macrocosmos.iota.tah.worker'))
  const evidence = parseLogs(records, state)
  const currentLocal = classify(evidence, app?.pid ?? null, worker.length > 0, control, Date.now() / 1000)
  const local = `${currentLocal.description} (${currentLocal.status})`
  const client = createOfficialClient()
  const official = await client.lookupMiner(minerId)
  const runId = official.runId
  const details = runId ? await client.queryDashboardDetails(runId, minerId).catch(() => null) : null
  const latestTokens = details?.tokens.data_points.at(-1)
  const lastProductive = details?.tokens.data_points.slice().reverse().find((point) => point.token_count > 0)
  const occupancyResponse = await client.request<{ run_ids: string[]; active_miners: number[]; max_miners: number[]; slots_remaining: number[] }>('/v1/runs_occupancy').catch(() => null)
  const runs = occupancyResponse?.data.run_ids.map((id, i) => `${id}: ${occupancyResponse.data.active_miners[i]}/${occupancyResponse.data.max_miners[i]} (余 ${occupancyResponse.data.slots_remaining[i]})`).join('\n') || '全网任务信息暂不可用'
  return [
    `IOTA 本地状态：${local}`,
    `应用进程：${app ? `运行中 PID ${app.pid}` : '未运行'}；main_pool：${worker.length} 个；控制连接：${control?.connected ? '正常' : '未连接'}`,
    `队列：${evidence.queueStatus ?? '—'}${evidence.queuePosition !== null ? `，第 ${evidence.queuePosition} 位` : ''}；训练状态：${evidence.trainingState ?? '—'}；最后训练活动：${date(evidence.trainingAt)}`,
    `官方状态：${official.status}；任务：${official.runId ?? '—'}；在线：${official.miner?.isActive ?? '—'}；吞吐：${num(official.miner?.throughput)}；激活：${num(official.miner?.activations, 0)}；采样：${date(official.miner?.sampleAt)}`,
    `官方产出：最新 token ${num(latestTokens?.token_count, 0)}；全网 token ${num(latestTokens?.network_tokens, 0)}；上次有产出 ${date(lastProductive?.timestamp)}；数据时间 ${date(official.lastSuccessfulFetchAt)}`,
    `全网任务容量：\n${runs}`,
    official.warning ? `提示：${official.warning}` : '',
  ].filter(Boolean).join('\n')
}

async function earningsText(minerId: string): Promise<string> {
  const client = createOfficialClient()
  const [totals, history] = await Promise.all([
    client.request<{ total_amount_earned: number; total_amount_paid: number; total_amount_pending: number; total_amount_frozen: number; minimum_payout_amount: number }>(`/v1/entitlements/totals/hotkey/${minerId}`),
    client.request<{ timestamps: number[]; alpha_amounts: number[]; statuses: string[] }>(`/v1/entitlements/history/hotkey/${minerId}`),
  ])
  const items = history.data.timestamps.map((ts, i) => ({ ts, amount: history.data.alpha_amounts[i] ?? 0, status: history.data.statuses[i] ?? 'unknown' })).sort((a, b) => b.ts - a.ts)
  const lines = items.map((item) => `${date(item.ts)} | ${num(item.amount)} IOTA | ${item.status}`)
  return [
    `收益总览：累计 ${num(totals.data.total_amount_earned)} IOTA；已支付 ${num(totals.data.total_amount_paid)}；待支付 ${num(totals.data.total_amount_pending)}；冻结 ${num(totals.data.total_amount_frozen)}；最低支付 ${num(totals.data.minimum_payout_amount)}`,
    '收益记录（最新在前）：', ...(lines.length ? lines : ['暂无记录']),
  ].join('\n')
}

async function restartAndReport(): Promise<string> {
  if (!appInstalled()) return '重启失败：未找到 IOTA Train at Home.app。'
  let appStartedAt = Date.now() / 1000
  try {
    const rows = await processes()
    await terminateIota(rows)
    await new Promise((resolve) => setTimeout(resolve, 5000))
    await startOptimized()
    const deadline = Date.now() + 120_000
    let appFound = false
    while (Date.now() < deadline) {
      const current = await processes().catch(() => new Map())
      if ([...current.values()].some((row) => row.command === appExecutablePath())) { appFound = true; appStartedAt = Date.now() / 1000; break }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!appFound) return '重启失败：启动后 2 分钟内未检测到 IOTA 进程。'
  } catch (error) {
    return `重启失败：${error instanceof Error ? error.message : String(error)}`
  }
  const speed = await waitForSpeedtest(appStartedAt, 15 * 60_000)
  if (!speed) return 'IOTA 进程已启动；等待测速结果超时（15 分钟），请查看本机 IOTA 日志。'
  const low = speed.download < LOW_SPEED && speed.upload < LOW_SPEED
  return `重启成功；测速时间 ${date(speed.at)}，下载 ${num(speed.download, 2)} Mbps，上传 ${num(speed.upload, 2)} Mbps。${low ? '测速仍低于 1 Mbps。' : ''}`
}

async function waitForSpeedtest(after: number, timeout: number): Promise<{ at: number; download: number; upload: number } | null> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const logsDir = join(homedir(), 'Library', 'Logs', 'IOTA Train at Home')
    const files = (await (await import('node:fs/promises')).readdir(logsDir).catch(() => [] as string[]))
      .filter((name) => name.includes('-cli') && name.endsWith('.log'))
    const candidates = await Promise.all(files.map(async (name) => {
      const path = join(logsDir, name)
      const info = await (await import('node:fs/promises')).stat(path).catch(() => null)
      return info ? { path, mtime: info.mtimeMs } : null
    }))
    const newest = candidates.filter((item): item is { path: string; mtime: number } => item !== null).sort((a, b) => b.mtime - a.mtime)[0]
    if (newest) {
      const text = await readFile(newest.path, 'utf8').catch(() => '')
      const found: { at: number; download: number; upload: number }[] = []
      for (const line of text.split('\n')) {
        const match = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\].*Speedtest completed with results:.*['\"]download_mbps['\"]:\s*([0-9.]+).*['\"]upload_mbps['\"]:\s*([0-9.]+)/.exec(line)
        if (!match) continue
        const at = Date.parse(match[1]!) / 1000
        if (at > after) found.push({ at, download: Number(match[2]), upload: Number(match[3]) })
      }
      if (found.length) return found.sort((a, b) => b.at - a.at)[0]!
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  return null
}

async function sendText(client: Client, chatId: string, text: string): Promise<void> {
  const lines = text.split('\n')
  let chunk = ''
  for (const line of lines) {
    if ((chunk + line).length > 3500 && chunk) {
      await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: chunk }) } })
      chunk = ''
    }
    chunk += `${line}\n`
  }
  if (chunk) await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: chunk.trim() }) } })
}

function controlCard() {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: 'IOTA miner-agent 控制台' }, template: 'blue' },
    body: { elements: [{ tag: 'action', actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '状态' }, type: 'primary', value: { command: 'status' } },
      { tag: 'button', text: { tag: 'plain_text', content: '重启' }, type: 'danger', value: { command: 'restart' }, confirm: { title: { tag: 'plain_text', content: '确认重启 IOTA？' }, text: { tag: 'plain_text', content: '将结束 IOTA 及 main_pool，然后重新启动。' } } },
      { tag: 'button', text: { tag: 'plain_text', content: '收益' }, value: { command: 'earnings' } },
    ] }] },
  }
}

export async function runFeishuDiscovery(): Promise<void> {
  const config = await loadFeishuConfig()
  if (!config) throw new Error(`请先运行 miner-agent feishu setup：${FEISHU_CONFIG_PATH}`)
  let paired = Boolean(config.chatId && config.allowedOpenIds.length)
  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      if (paired || data.message.chat_type !== 'p2p') return
      const openId = data.sender.sender_id?.open_id ?? '(没有 open_id)'
      console.log(`收到配对消息：chat_id=${data.message.chat_id} open_id=${openId} chat_type=${data.message.chat_type}`)
      const current = await loadFeishuConfig()
      if (current && !current.chatId && openId !== '(没有 open_id)') {
        await pairFeishuChat(data.message.chat_id, [openId])
        await installFeishuLaunchAgent()
        paired = true
        console.log('已自动配对并安装飞书机器人登录服务；此会话中的控制命令只允许该用户。')
      }
    },
  })
  const ws = new WSClient({ appId: config.appId, appSecret: config.appSecret, domain: 'https://open.feishu.cn' })
  console.log('正在连接飞书，请在机器人单聊里发任意消息完成自动配对……')
  await ws.start({ eventDispatcher: dispatcher })
  const deadline = Date.now() + 120_000
  while (!paired && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500))
  if (!paired) throw new Error('等待飞书配对超时，请重新运行 miner-agent feishu connect')
}

export async function runFeishuBot(minerId: string): Promise<void> {
  if (!validateMinerId(minerId).valid) throw new Error('先配置有效 Miner ID：miner-agent feishu setup')
  const config = await loadFeishuConfig()
  if (!config) throw new Error(`飞书尚未配置。配置文件：${FEISHU_CONFIG_PATH}`)
  if (!config.chatId || config.allowedOpenIds.length === 0) throw new Error('飞书控制未完成配对：请配置 chat_id 和至少一个允许控制的 open_id。先运行 miner-agent feishu connect 完成配对。')
  const client = new Client({ appId: config.appId, appSecret: config.appSecret, domain: 'https://open.feishu.cn' })
  const allowed = new Set(config.allowedOpenIds)
  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const sender = data.sender.sender_id?.open_id
      if (!sender || !allowed.has(sender) || data.message.chat_id !== config.chatId || data.message.message_type !== 'text') return
      let text = ''
      try { text = String((JSON.parse(data.message.content) as { text?: string }).text ?? '').trim() } catch { return }
      try {
        if (text === '状态') await sendText(client, config.chatId, await statusText(minerId))
        else if (text === '重启') await sendText(client, config.chatId, await restartAndReport())
        else if (text === '收益') await sendText(client, config.chatId, await earningsText(minerId))
      } catch (error) { await sendText(client, config.chatId, `命令执行失败：${error instanceof Error ? error.message : String(error)}`) }
    },
    'card.action.trigger': async (evt: CardActionEvent) => {
      if (!allowed.has(evt.operator.openId) || evt.chatId !== config.chatId) return
      const action = (evt.action.value as { command?: string } | undefined)?.command
      try {
        const text = action === 'status' ? await statusText(minerId) : action === 'restart' ? await restartAndReport() : action === 'earnings' ? await earningsText(minerId) : ''
        if (text) await sendText(client, config.chatId, text)
      } catch (error) { await sendText(client, config.chatId, `命令执行失败：${error instanceof Error ? error.message : String(error)}`) }
    },
  })
  const ws = new WSClient({ appId: config.appId, appSecret: config.appSecret, domain: 'https://open.feishu.cn' })
  await ws.start({ eventDispatcher: dispatcher })
  await event('飞书机器人长连接已启动')
  await sendText(client, config.chatId, 'IOTA miner-agent 已连接。可发送：状态、重启、收益。')
  console.log(`miner-agent Feishu bot connected; target chat ${config.chatId}`)
  while (true) {
    try { if (config.speedtestRecoveryEnabled !== false) await checkSpeedtestRecovery(client, config) }
    catch (error) { await event(`测速恢复监控失败：${error instanceof Error ? error.message : String(error)}`) }
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
}
