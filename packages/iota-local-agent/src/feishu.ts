import { Client, EventDispatcher, WSClient, type CardActionEvent } from '@larksuiteoapi/node-sdk'
import { readFile, readdir, stat, mkdir, chmod, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { appInstalled, startOptimized } from './launcher.js'
import { CONFIG_PATH } from './paths.js'
import { activityLabel, activityTiming, formatDuration, resolveActivity, trackActivity } from './activity-monitor.js'
import { recordStateChange, recordEpochContributions } from './local-history.js'
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

async function monitorMinerActivity(config: FeishuCredentials): Promise<void> {
  const [rows, records, previous] = await Promise.all([processes(), logRecords(), readState<GuardianState>()])
  const evidence = parseLogs(records, previous)
  const appRunning = [...rows.values()].some((row) => row.command === appExecutablePath())
  const official = await createOfficialClient().lookupMiner(config.minerId).catch(() => null)
  const current = resolveActivity(config.minerId, evidence, appRunning, Date.now() / 1000, official)
  const timing = await activityTiming(join(AGENT_DIR, 'activity-monitor-state.json'), current, records, evidence.sessionStartedAt)
  if (current) current.startedAt = timing?.startedAt ?? null
  await trackActivity(join(AGENT_DIR, 'activity-monitor-state.json'), current, async (before, after) => {
    await recordStateChange(before, after)
    const message = [
      `IOTA 状态变化：${activityLabel(before.kind)} → ${activityLabel(after.kind)}`,
      `变化时间：${date(after.observedAt)}`,
      `上一状态持续：${before.startedAt == null ? '未知' : formatDuration(after.observedAt - before.startedAt)}`,
      `Miner ID：${after.minerId}`,
      `任务：${after.runId ?? '尚未分配'}${after.kind === 'queued' && after.queuePosition !== null ? `；排队第 ${after.queuePosition} 位` : ''}`,
      `依据：${after.source}`,
      updatedAt(),
    ].join('\n')
    await fanoutAgentAlert(config, await loadAgentConfig(), message)
    await event(`IOTA 状态变化已推送：${before.kind} -> ${after.kind}；run=${after.runId ?? '—'}`)
  })
}

async function collectContributionHistory(minerId: string): Promise<void> {
  const client = createOfficialClient()
  const official = await client.lookupMiner(minerId)
  const state = await readState<GuardianState>()
  // Include the last known local run even when the current roster is unavailable.
  const runIds = new Set([official.runId, state.trainingRunId].filter((id): id is string => Boolean(id)))
  const results = await Promise.allSettled([...runIds].map(async (runId) => {
    const details = await client.queryDashboardDetails(runId, minerId)
    await recordEpochContributions(minerId, runId, details)
  }))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}

export function date(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const millis = ts > 100_000_000_000 ? ts : ts * 1000
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(millis))
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '00'
  return `${part('month')}/${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}
function num(n: number | null | undefined, digits = 4): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—'
}
function updatedAt(): string { return `更新时间：${date(Date.now())}` }
export function dateMinute(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const millis = ts > 100_000_000_000 ? ts : ts * 1000
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(millis))
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '00'
  return `${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`
}
type DashboardDetails = Awaited<ReturnType<ReturnType<typeof createOfficialClient>['queryDashboardDetails']>>

// Decimal SI units; G denotes billions rather than the locale-dependent B.
export function compactMetric(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const units = ['', 'K', 'M', 'G', 'T']
  let scaled = Math.abs(value), unit = 0
  while (scaled >= 1000 && unit < units.length - 1) { scaled /= 1000; unit++ }
  scaled = Number(scaled.toFixed(1))
  if (scaled >= 1000 && unit < units.length - 1) { scaled /= 1000; unit++ }
  return `${value < 0 && scaled !== 0 ? '-' : ''}${scaled}${units[unit]}`
}

export function trainingRows(details: DashboardDetails | null): string[] {
  if (!details) return []
  const { metrics, throughput, tokens } = details
  const throughputByEpoch = new Map(throughput.epochs.map((epoch, i) => [epoch, throughput.throughputs[i]]))
  const cumulativePoints = [...tokens.data_points].sort((a, b) => a.timestamp - b.timestamp)
  const plain = (value: number | null | undefined, digits = 0): string =>
    typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits }) : '—'
  return metrics.epochs.map((epoch, i) => ({
    epoch, ts: metrics.timestamps[i] ?? 0,
    tokens: metrics.token_counts[i], contribution: metrics.act_contribution_percs[i],
    rank: metrics.activation_ranks[i], total: metrics.num_hotkeys_in_epochs[i],
  })).filter((record) => record.ts > 0).sort((a, b) => b.ts - a.ts).slice(0, 10).map((record) => {
    // Token totals are sampled independently; never use a future sample for a historical epoch.
    const cumulative = cumulativePoints.filter((point) => point.timestamp <= record.ts).at(-1)
    const contribution = typeof record.contribution === 'number' && Number.isFinite(record.contribution)
      ? `${(record.contribution * 100).toFixed(2)}%` : '—'
    const rank = record.rank !== undefined && record.rank > 0 ? `${record.rank}/${plain(record.total)}` : '—'
    return `#${record.epoch}   |   ${compactMetric(record.tokens)}   |   ${contribution}   |   ${rank}   |   ${compactMetric(throughputByEpoch.get(record.epoch))}   |   ${compactMetric(cumulative?.token_count)}   |   ${dateMinute(record.ts)}`
  })
}

export function statusTime(isTraining: boolean, sampleAt: number | null | undefined, lastTrainingAt: number | null): string {
  return isTraining ? `采样：${date(sampleAt)}` : `最后训练：${date(lastTrainingAt)}`
}

export function taskLabel(runId: string | null): string {
  return runId || '—'
}

async function processUptimeSeconds(pid: number): Promise<number> {
  const output = await execFileText('ps', ['-o', 'etime=', '-p', String(pid)])
  const value = output.trim()
  const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('无法解析进程运行时长')
  return (Number(match[1] ?? 0) * 86400) + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4])
}

async function statusText(minerId: string): Promise<string> {
  const [rows, records, state] = await Promise.all([processes(), logRecords(), readState<GuardianState>()])
  const appPath = appExecutablePath()
  const app = [...rows.values()].find((row) => row.command === appPath)
  const evidence = parseLogs(records, state)
  const historicalTraining = await latestTraining()
  const client = createOfficialClient()
  const official = await client.lookupMiner(minerId)
  const runId = official.runId
  const [details, networkRuns] = await Promise.all([
    runId ? client.queryDashboardDetails(runId, minerId).catch(() => null) : Promise.resolve(null),
    client.networkRuns().catch(() => null),
  ])
  if (details && runId) await recordEpochContributions(minerId, runId, details)
  const points = details?.tokens.data_points ?? []
  const productivePoints = points.filter((point) => point.token_count > 0).sort((a, b) => b.timestamp - a.timestamp)
  const latestProductive = productivePoints[0]
  const metrics = details?.metrics
  const lastProductiveEpochTs = metrics ? Math.max(0, ...metrics.timestamps.filter((_, i) => (metrics.token_counts[i] ?? 0) > 0)) : 0
  const latestEpochTs = Math.max(lastProductiveEpochTs, latestProductive?.timestamp ?? 0, historicalTraining?.at ?? 0, evidence.trainingAt ?? 0) || null
  const activity = resolveActivity(minerId, evidence, Boolean(app), Date.now() / 1000, official)
  const headline = `状态：${activity ? activityLabel(activity.kind) : '状态待确认'}${activity?.kind === 'queued' && evidence.queuePosition !== null ? `，第 ${evidence.queuePosition} 位` : ''}，任务：${taskLabel(activity?.runId ?? official.runId)}；吞吐：${num(official.miner?.throughput)}；激活：${num(official.miner?.activations, 0)}；${statusTime(activity?.kind === 'training', official.miner?.sampleAt, latestEpochTs)}`
  const timing = await activityTiming(join(AGENT_DIR, 'activity-monitor-state.json'), activity, records, evidence.sessionStartedAt)
  const timingLine = timing
    ? `本状态开始：${date(timing.startedAt)}；已持续：${formatDuration(timing.elapsedSeconds)}（自可识别记录起）`
    : '本状态持续时间：未知（Agent 与 IOTA 日志均无可识别的状态起点）'
  const separator = '--------------------------------------------------'
  const trainingLines = trainingRows(details)
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
    timingLine,
    `应用进程：${app ? `运行中，PID ${app.pid}，进程时长：${processElapsed === null ? '未知' : `${(processElapsed / 3600).toFixed(1)} h`}` : '未运行'}`,
    ...(trainingLines.length ? [separator, '训练记录（最近 10 轮，最新在前）：', '轮次   |   训练 Token   |   贡献   |   激活排名   |   吞吐   |   累计 Token   |   采样', trainingLines.join('\n')] : []),
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
    `收益总览：累计 ${num(totals.data.total_amount_earned)} IOTA；已支付 ${num(totals.data.total_amount_paid)}；待支付 ${num(totals.data.total_amount_pending)}；冻结 ${num(totals.data.total_amount_frozen)}`,
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
    return `手动重启未执行：${current.description}。安全策略仅允许在最近十五分钟确认排队时重启；不会自动重启。\n${updatedAt()}`
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
          : `手动重启未执行：官方查询结果为「${activityName}」，不能据此确认本地是否运行。安全策略仅允许在确认排队时重启；不会自动重启。\n${updatedAt()}`
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
  let nextHistoryCollectionAt = 0
  while (true) {
    try {
      const agentConfig = await loadAgentConfig()
      await monitorIotaProcesses(client, { ...config, ...agentConfig })
    }
    catch (error) { await event(`IOTA 进程监控失败：${error instanceof Error ? error.message : String(error)}`) }
    try { await monitorMinerActivity({ ...config, minerId }) }
    catch (error) { await event(`IOTA 状态变化监控失败：${error instanceof Error ? error.message : String(error)}`) }
    if (Date.now() >= nextHistoryCollectionAt) {
      nextHistoryCollectionAt = Date.now() + 300_000
      try { await collectContributionHistory(minerId) }
      catch (error) { await event(`历史贡献采集失败：${error instanceof Error ? error.message : String(error)}`) }
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
}
