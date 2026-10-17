import { Client, EventDispatcher, WSClient, type CardActionEvent } from '@larksuiteoapi/node-sdk'
import { readFile, readdir, stat, mkdir, chmod, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { appInstalled, startOptimized } from './launcher.js'
import { CONFIG_PATH } from './paths.js'
import { latestTraining } from './training-history.js'
import { createOfficialClient } from './official.js'
import { appExecutablePath, classify, execFileText, health, iotaProcessSnapshot, logRecords, parseLogs, processes, type GuardianState } from './guardian.js'
import { terminateIotaAppNow, killIotaWorkersNow } from './guardian.js'
import { readState, event } from './state.js'
import { AGENT_DIR, PROCESS_MONITOR_STATE_PATH, SPEEDTEST_ALERT_STATE_PATH } from './paths.js'
import { installFeishuLaunchAgent } from './launchagent.js'
import { validateMinerId } from './ss58.js'
import { detectLocalMinerIds, type LocalMinerIdentity } from './identity.js'
import { fanoutAgentAlert, loadAgentConfig, type AgentConfig } from './feishu-alert.js'

export interface FeishuCredentials extends AgentConfig { appId: string; appSecret: string; chatId: string; minerId: string; allowedOpenIds: string[]; processAlertsEnabled?: boolean }
const FEISHU_CONFIG_PATH = join(homedir(), '.miner-agent', 'feishu.json')


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
  const next: FeishuCredentials = {
    appId: appId.trim(), appSecret: appSecret.trim(), minerId: selected.minerId,
    chatId: current?.chatId ?? '', allowedOpenIds: current?.allowedOpenIds ?? [],
  }
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


let manualRestartInProgress = false

interface PersistedIotaSnapshot {
  appPid: number | null
  workers: Array<{ pid: number; command: string }>
  initialized: boolean
  observedAt: number
}
export function endedIotaProcesses(
  previous: Pick<PersistedIotaSnapshot, 'appPid' | 'workers'>,
  current: Pick<PersistedIotaSnapshot, 'appPid' | 'workers'>,
): { appEnded: boolean; appReplaced: boolean; endedWorkers: PersistedIotaSnapshot['workers'] } {
  return {
    appEnded: previous.appPid !== null && current.appPid === null,
    appReplaced: previous.appPid !== null && current.appPid !== null && previous.appPid !== current.appPid,
    endedWorkers: previous.workers.filter((old) => !current.workers.some((now) => now.pid === old.pid && now.command === old.command)),
  }
}

async function monitorSpeedtest(client: Client, config: FeishuCredentials): Promise<void> {
  let lastProcessedAt = 0
  try {
    const saved = JSON.parse(await readFile(SPEEDTEST_ALERT_STATE_PATH, 'utf8')) as { lastProcessedAt?: number }
    lastProcessedAt = saved.lastProcessedAt ?? 0
  } catch {}
  const matches = (await logRecords()).flatMap((record) => {
    const match = /Speedtest completed with results:.*['\"]download_mbps['\"]:\s*([0-9.]+).*['\"]upload_mbps['\"]:\s*([0-9.]+)/.exec(record.line)
    if (!match || record.t <= lastProcessedAt) return []
    return [{ at: record.t, download: Number(match[1]), upload: Number(match[2]) }]
  }).sort((a, b) => a.at - b.at)
  if (!matches.length) return
  const latest = matches[matches.length - 1]!
  if (latest.download < 1 && latest.upload < 1) {
    const alert = `IOTA 网络测速异常：下载 ${num(latest.download, 2)} Mbps，上传 ${num(latest.upload, 2)} Mbps。未自动重启，请检查后决定是否通过飞书手动「重启」。\n测速时间：${date(latest.at)}\n${updatedAt()}`
    await fanoutAgentAlert(config, await loadAgentConfig(), alert)
    await event(`低速测速告警已发送：at=${latest.at} download=${latest.download}Mbps upload=${latest.upload}Mbps；仅告警，不自动重启`)
  } else if (latest.download < 1 || latest.upload < 1) {
    await event(`测速单项低于 1 Mbps，未满足双向低速告警条件：at=${latest.at} download=${latest.download}Mbps upload=${latest.upload}Mbps`)
  }
  await mkdir(dirname(SPEEDTEST_ALERT_STATE_PATH), { recursive: true })
  await writeFile(SPEEDTEST_ALERT_STATE_PATH, JSON.stringify({ lastProcessedAt: latest.at }, null, 2) + '\n', { mode: 0o600 })
  await chmod(SPEEDTEST_ALERT_STATE_PATH, 0o600)
}

async function monitorIotaProcesses(client: Client, config: FeishuCredentials): Promise<void> {
  const current = await iotaProcessSnapshot()
  let previous: PersistedIotaSnapshot | null = null
  try { previous = JSON.parse(await readFile(PROCESS_MONITOR_STATE_PATH, 'utf8')) as PersistedIotaSnapshot } catch {}
  await mkdir(dirname(PROCESS_MONITOR_STATE_PATH), { recursive: true })
  const next: PersistedIotaSnapshot = {
    appPid: current.appPid,
    workers: current.workers,
    initialized: true,
    observedAt: current.capturedAt,
  }
  // First sample establishes baseline; don't report processes that predate monitor startup.
  let alertDeliveryFailed = false
  if (previous?.initialized) {
    const changes = endedIotaProcesses(previous, current)
    const parts: string[] = []
    if (changes.appEnded) parts.push(`IOTA 主程序 PID ${previous.appPid} 已结束`)
    if (changes.appReplaced) parts.push(`IOTA 主程序已更换（PID ${previous.appPid} → ${current.appPid}）`)
    if (changes.endedWorkers.length) parts.push(`${changes.endedWorkers.length} 个 main_pool 进程已结束：${changes.endedWorkers.map((row) => `PID ${row.pid}`).join(', ')}`)
    if (parts.length && config.processAlertsEnabled !== false && !manualRestartInProgress) {
      const alertText = `IOTA 进程状态变化：${parts.join('；')}。当前主程序 ${current.appPid === null ? '未运行' : `PID ${current.appPid}`}，main_pool ${current.workerCount} 个。\n${updatedAt()}`
      try {
        await fanoutAgentAlert(config, await loadAgentConfig(), alertText)
        await event(`IOTA 进程告警已发送：${parts.join('；')}`)
      } catch (error) {
        alertDeliveryFailed = true
        await event(`IOTA 进程告警发送失败：${parts.join('；')}；${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  // Keep the old baseline if delivery fails; the next 30-second poll retries the same alert.
  if (!alertDeliveryFailed) {
    await writeFile(PROCESS_MONITOR_STATE_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    await chmod(PROCESS_MONITOR_STATE_PATH, 0o600)
  }
}

function date(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const millis = ts > 100_000_000_000 ? ts : ts * 1000
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(millis))
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '00'
  return `${part('month')}月${part('day')}日 ${part('hour')}:${part('minute')}:${part('second')}`
}
function num(n: number | null | undefined, digits = 4): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—'
}
function updatedAt(): string { return `更新时间：${date(Date.now())}` }
function dateMinute(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const millis = ts > 100_000_000_000 ? ts : ts * 1000
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(millis))
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '00'
  return `${part('month')}月${part('day')}日 ${part('hour')}:${part('minute')}`
}
function relativeAge(ts: number, nowSec = Date.now() / 1000): string {
  const days = Math.max(0, Math.floor((nowSec - ts) / 86400))
  if (days === 0) return '今天'
  if (days === 1) return '1天前'
  return `${days}天前`
}

async function processUptimeSeconds(pid: number): Promise<number> {
  const output = await execFileText('ps', ['-o', 'etime=', '-p', String(pid)])
  const value = output.trim()
  const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('无法解析进程运行时长')
  return (Number(match[1] ?? 0) * 86400) + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4])
}

async function statusText(minerId: string): Promise<string> {
  const [rows, records, state, control] = await Promise.all([processes(), logRecords(), readState<GuardianState>(), health()])
  const appPath = appExecutablePath()
  const app = [...rows.values()].find((row) => row.command === appPath)
  const worker = [...rows.values()].filter((row) => row.command.startsWith(`${appPath.replace('/Contents/MacOS/IOTA Train at Home', '/Contents/Frameworks/iota-cli/main_pool')}`) || row.command.startsWith('main_pool:ai.macrocosmos.iota.tah.worker'))
  const evidence = parseLogs(records, state)
  const historicalTraining = await latestTraining()
  const localState = classify(evidence, app?.pid ?? null, worker.length > 0, control, Date.now() / 1000)
  const client = createOfficialClient()
  const official = await client.lookupMiner(minerId)
  const runId = official.runId
  const [details, networkRuns] = await Promise.all([
    runId ? client.queryDashboardDetails(runId, minerId).catch(() => null) : Promise.resolve(null),
    client.networkRuns().catch(() => null),
  ])
  const points = details?.tokens.data_points ?? []
  const productivePoints = points.filter((point) => point.token_count > 0).sort((a, b) => b.timestamp - a.timestamp)
  const latestProductive = productivePoints[0]
  const metrics = details?.metrics
  const epochRecords = metrics ? metrics.epochs.map((epoch, i) => ({
    epoch,
    ts: metrics.timestamps[i] ?? 0,
    rank: metrics.activation_ranks[i] ?? null,
    total: metrics.num_hotkeys_in_epochs[i] ?? null,
    uploaded: (metrics.weight_uploaded[i] ?? 0) > 0,
  })).filter((record) => record.ts > 0).sort((a, b) => b.ts - a.ts).slice(0, 10) : []
  const latestEpochTs = Math.max(epochRecords[0]?.ts ?? 0, latestProductive?.timestamp ?? 0, historicalTraining?.at ?? 0, evidence.trainingAt ?? 0) || null
  const isQueuedLocally = official.miner === null && (evidence.queueStatus === 'queued' || localState.status === 'queued')
  const officialStatus = official.status === 'contributing'
    ? '训练中'
    : official.status === 'waiting'
      ? '等待任务中'
      : official.status === 'idle'
        ? '未训练'
        : official.status === 'not_found'
          ? '官方名单未找到'
          : official.status === 'refresh_interrupted'
            ? '官方数据刷新中断'
            : '状态待确认'
  const task = official.runId ? networkRuns?.find((run) => run.runId === official.runId) : null
  const headline = isQueuedLocally
    ? `状态：排队中${evidence.queuePosition === null ? '' : `，第 ${evidence.queuePosition} 位`}，最后训练：${date(latestEpochTs)}`
    : `状态：${officialStatus}，任务：${task?.description || official.runId || '—'}；吞吐：${num(official.miner?.throughput)}；激活：${num(official.miner?.activations, 0)}；采样：${date(official.miner?.sampleAt)}；上一次产出：${date(latestProductive?.timestamp)}`
  const separator = '--------------------------------------------------'
  const trainingLines = epochRecords.map((record) => {
    const rank = record.rank !== null && record.rank > 0 ? `${record.rank} / ${record.total ?? '—'}` : '—'
    const upload = record.uploaded ? 'weights uploaded' : 'weights not uploaded'
    return `#${record.epoch}，${dateMinute(record.ts)}（${relativeAge(record.ts)}），${upload}，${rank}`
  })
  const runGroups: Array<[string, string, NonNullable<typeof networkRuns>[number][]]> = [
    ['金级', 'Gold', (networkRuns ?? []).filter((run) => run.tier === 'gold')],
    ['银级', 'Silver', (networkRuns ?? []).filter((run) => run.tier === 'silver')],
    ['铜级', 'Bronze', (networkRuns ?? []).filter((run) => run.tier === 'bronze')],
    ['其他', 'Other', (networkRuns ?? []).filter((run) => run.tier === 'other')],
  ]
  const capacity = networkRuns
    ? runGroups.filter(([, , runs]) => runs.length > 0).map(([label, english, runs]) => `${label}（${english}）：\n${runs.map((run) => {
      const modelPrefix = run.modelSize || run.model || '1B'
      return `${modelPrefix} - ${run.runId}：${run.activeMiners}/${run.maxMiners}（剩余 ${run.slotsRemaining}）`
    }).join('\n')}`).join('\n') || '当前没有全网任务'
    : '全网任务信息暂不可用'
  const processElapsed = app ? await processUptimeSeconds(app.pid).catch(() => null) : null
  const output = [
    headline,
    `应用进程：${app ? `运行中，PID ${app.pid}，进程时长：${processElapsed === null ? '未知' : `${(processElapsed / 3600).toFixed(1)} h`}` : '未运行'}；main_pool：${worker.length} 个；控制连接：${control?.connected ? '正常' : '未连接'}`,
    ...(trainingLines.length ? [separator, '训练记录：', '轮次\t时间\t状态\t排名', ...trainingLines] : []),
    separator,
    `全网任务容量：\n${capacity}`,
    separator,
    updatedAt(),
  ]
  return output.join('\n')
}

async function earningsText(minerId: string): Promise<string> {
  const client = createOfficialClient()
  const [totals, history] = await Promise.all([
    client.request<{ total_amount_earned: number; total_amount_paid: number; total_amount_pending: number; total_amount_frozen: number; minimum_payout_amount: number }>(`/v1/entitlements/totals/hotkey/${minerId}`),
    client.request<{ timestamps: number[]; alpha_amounts: number[]; statuses: string[] }>(`/v1/entitlements/history/hotkey/${minerId}`),
  ])
  const items = history.data.timestamps.map((ts, i) => ({ ts, amount: history.data.alpha_amounts[i] ?? 0, status: history.data.statuses[i] ?? 'unknown' })).sort((a, b) => b.ts - a.ts)
  const lines = items.filter((item) => item.amount > 0).map((item) => `${date(item.ts)} | ${num(item.amount)} IOTA | ${item.status}`)
  return [
    `收益总览：累计 ${num(totals.data.total_amount_earned)} IOTA；已支付 ${num(totals.data.total_amount_paid)}；待支付 ${num(totals.data.total_amount_pending)}；冻结 ${num(totals.data.total_amount_frozen)}；最低支付 ${num(totals.data.minimum_payout_amount)}`,
    '收益记录（最新在前）：', ...(lines.length ? lines : ['暂无记录']),
    updatedAt(),
  ].join('\n')
}

async function restartAndReport(traceText: string): Promise<string> {
  // Recheck local evidence immediately before any destructive operation.
  const [rows, records, previous, control] = await Promise.all([processes(), logRecords(), readState<GuardianState>(), health()])
  const appPath = appExecutablePath()
  const app = [...rows.values()].find((row) => row.command === appPath)
  const evidence = parseLogs(records, previous)
  const workers = [...rows.values()].some((row) => row.command.startsWith(appPath.replace('/Contents/MacOS/IOTA Train at Home', '/Contents/Frameworks/iota-cli/main_pool')) || row.command.startsWith('main_pool:ai.macrocosmos.iota.tah.worker'))
  const current = classify(evidence, app?.pid ?? null, workers, control, Date.now() / 1000)
  if (current.status !== 'queued' || !evidence.queueUpdatedAt || Date.now() / 1000 - evidence.queueUpdatedAt > 900) {
    return `当前${current.description}，不建议自动重启；本次未执行重启。\n${updatedAt()}`
  }
  manualRestartInProgress = true
  const result = async (text: string): Promise<string> => `${text}\n${updatedAt()}`
  if (!appInstalled()) { manualRestartInProgress = false; return result('重启失败：未找到 IOTA Train at Home.app。') }
  const before = Date.now() / 1000
  try {
    const appCount = await terminateIotaAppNow()
    await event(`飞书手动重启阶段完成：${traceText}；已结束 ${appCount} 个 IOTA 主进程，等待 3 秒`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const workerCount = await killIotaWorkersNow()
    await event(`飞书手动重启阶段完成：${traceText}；已结束 ${workerCount} 个 main_pool 相关进程，等待 5 秒`)
    await new Promise((resolve) => setTimeout(resolve, 5000))
    await event(`飞书手动重启启动阶段开始：${traceText}`)
    await startOptimized()
    await event(`飞书手动重启启动阶段成功：${traceText}`)
  } catch (error) {
    await event(`飞书手动重启失败：${traceText}；${error instanceof Error ? error.message : String(error)}`)
    manualRestartInProgress = false
    return result(`重启失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const speed = await waitForSpeedtest(before, 15 * 60_000)
  manualRestartInProgress = false
  if (!speed) return result('重启请求已提交，但 15 分钟内没有检测到新测速结果；请用 ma status 检查 IOTA 进程。')
  return result(`重启完成；测速时间 ${date(speed.at)}，下载 ${num(speed.download, 2)} Mbps，上传 ${num(speed.upload, 2)} Mbps。`)
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


export async function runFeishuDiscovery(): Promise<void> {
  const config = await loadFeishuConfig()
  if (!config) throw new Error(`请先运行 ma feishu setup：${FEISHU_CONFIG_PATH}`)
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
  if (!paired) throw new Error('等待飞书配对超时，请重新运行 ma feishu connect')
}

export async function runFeishuBot(minerId: string): Promise<void> {
  if (!validateMinerId(minerId).valid) throw new Error('先配置有效 Miner ID：ma feishu setup')
  const config = await loadFeishuConfig()
  if (!config) throw new Error(`飞书尚未配置。配置文件：${FEISHU_CONFIG_PATH}`)
  if (!config.chatId || config.allowedOpenIds.length === 0) throw new Error('飞书控制未完成配对：请配置 chat_id 和至少一个允许控制的 open_id。先运行 ma feishu connect 完成配对。')
  const botConfig = config
  const client = new Client({ appId: botConfig.appId, appSecret: botConfig.appSecret, domain: 'https://open.feishu.cn' })
  const allowed = new Set(botConfig.allowedOpenIds)
  const handled = new Map<string, number>()
  const inFlight = new Set<string>()
  async function markAcknowledged(messageId: string): Promise<void> {
    try {
      await client.im.v1.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: 'DONE' } } })
    } catch (error) {
      await event(`添加命令已读表情失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  async function handleCommand(sender: string, command: string, messageId: string, trace: { eventId?: string; chatId?: string; chatType?: string; source: string }): Promise<void> {
    const now = Date.now()
    for (const [seen, expiry] of handled) if (expiry <= now) handled.delete(seen)
    if (command !== 'status' && command !== 'restart' && command !== 'earnings') return
    // Merge repeated commands from the same user for one minute, including duplicate delivery paths.
    const key = `${botConfig.chatId}:${sender}:${command}`
    if (handled.has(key) || inFlight.has(key)) return
    handled.set(key, now + 60_000)
    inFlight.add(key)
    const traceText = `来源=${trace.source} event_id=${trace.eventId ?? '—'} message_id=${messageId || '—'} sender.open_id=${sender} chat_id=${trace.chatId ?? botConfig.chatId} chat_type=${trace.chatType ?? '—'} command=${command}`
    await event(`飞书命令收到：${traceText}`)
    await markAcknowledged(messageId)
    await event(`飞书命令已读确认：${traceText}`)
    try {
      let result: string
      if (command === 'status') {
        result = await statusText(minerId)
      } else if (command === 'restart') {
        const current = await statusText(minerId)
        const headline = current.split('\n', 1)[0] ?? ''
        const activityName = /^状态：([^，；]+)/.exec(headline)?.[1] ?? '状态无法确认'
        const queued = activityName === '排队中'
        result = queued
          ? await restartAndReport(traceText)
          : `当前${activityName}，不建议自动重启；为保护 IOTA 进程，本次未执行重启。\n${updatedAt()}`
      } else {
        result = await earningsText(minerId)
      }
      await event(`飞书命令执行成功：${traceText}`)
      await sendText(client, botConfig.chatId, result)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await event(`飞书命令执行失败：${traceText} error=${reason}`)
      await sendText(client, botConfig.chatId, `命令执行失败：${reason}`)
    } finally {
      inFlight.delete(key)
    }
  }

  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const sender = data.sender.sender_id?.open_id
      if (!sender || !allowed.has(sender) || data.message.chat_id !== botConfig.chatId || data.message.message_type !== 'text') return
      let text = ''
      try { text = String((JSON.parse(data.message.content) as { text?: string }).text ?? '').trim() } catch { return }
      const command = text === '状态' ? 'status' : text === '重启' ? 'restart' : text === '收益' ? 'earnings' : ''
      if (command) await handleCommand(sender, command, data.message.message_id, { source: 'message', eventId: data.event_id ?? '', chatId: data.message.chat_id, chatType: data.message.chat_type })
    },
    'card.action.trigger': async (evt: CardActionEvent) => {
      if (!allowed.has(evt.operator.openId) || evt.chatId !== botConfig.chatId) return
      const action = (evt.action.value as { command?: string } | undefined)?.command
      const command = action === 'status' || action === 'restart' || action === 'earnings' ? action : ''
      if (command) {
        await handleCommand(evt.operator.openId, command, evt.messageId, { source: 'card', eventId: String((evt.raw as { header?: { event_id?: string }; event_id?: string } | undefined)?.header?.event_id ?? (evt.raw as { event_id?: string } | undefined)?.event_id ?? ''), chatId: evt.chatId, chatType: 'card_action' })
      }
    },
  })
  const ws = new WSClient({ appId: config.appId, appSecret: config.appSecret, domain: 'https://open.feishu.cn' })
  await ws.start({ eventDispatcher: dispatcher })
  await event('飞书机器人长连接已启动')
  await sendText(client, botConfig.chatId, 'IOTA ma 已连接。可发送：状态、重启、收益。')
  console.log(`ma Feishu bot connected; target chat ${botConfig.chatId}`)
  while (true) {
    try {
      const agentConfig = await loadAgentConfig()
      await monitorIotaProcesses(client, { ...config, ...agentConfig })
    }
    catch (error) { await event(`IOTA 进程监控失败：${error instanceof Error ? error.message : String(error)}`) }
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
}
