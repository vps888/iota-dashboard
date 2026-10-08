import type { OfficialHistory, OfficialMetrics, OfficialMinerList, OfficialRuns, OfficialThroughput, OfficialTokens } from './schema.js'
import { parseOfficialPayload, upstreamKind } from './schema.js'
import { validateMinerId } from './ss58.js'
import type { OfficialLookup, OfficialMinerSample, OfficialStatus } from './types.js'

const API_BASE = 'https://iota-web.api.macrocosmos.ai/mainnet'
const FRESH_MS = 60_000
const RETAIN_MS = 10 * 60_000
const INTERRUPTED_MS = 5 * 60_000
const TIMEOUT_MS = 10_000
const MAX_CONCURRENT = 3

type CachedResponse = { data: unknown; fetchedAt: number; retryAt: number; failures: number }
type OfficialResponse<T> = { data: T; fetchedAt: number; stale: boolean }
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type DiscoveryRun = { run_id: string; state: string }
type ApiMiner = OfficialMinerList['miners'][number]

export interface OfficialClientOptions {
  fetch?: Fetcher
  now?: () => number
  timeoutMs?: number
  cacheTtlMs?: number
  retainMs?: number
  concurrency?: number
}

export function createOfficialClient(options: OfficialClientOptions = {}) {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const cacheTtlMs = options.cacheTtlMs ?? FRESH_MS
  const retainMs = options.retainMs ?? RETAIN_MS
  const concurrency = options.concurrency ?? MAX_CONCURRENT
  const cache = new Map<string, CachedResponse>()
  const failureBackoff = new Map<string, { failures: number; retryAt: number }>()
  const inFlight = new Map<string, Promise<OfficialResponse<unknown>>>()
  const waiting: Array<() => void> = []
  let active = 0

  async function acquire(): Promise<() => void> {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    return () => {
      active -= 1
      waiting.shift()?.()
    }
  }

  async function request<T>(path: string): Promise<OfficialResponse<T>> {
    upstreamKind(path)
    const key = path
    const cached = cache.get(key)
    const timestamp = now()
    if (cached && timestamp - cached.fetchedAt < cacheTtlMs) {
      return { data: cached.data as T, fetchedAt: cached.fetchedAt, stale: false }
    }
    const backoff = failureBackoff.get(key)
    if (backoff && timestamp < backoff.retryAt) {
      if (cached && timestamp - cached.fetchedAt <= retainMs) return { data: cached.data as T, fetchedAt: cached.fetchedAt, stale: true }
      throw new Error('官方 API 正在退避重试，暂时没有可用数据')
    }
    if (cached && timestamp < cached.retryAt) {
      if (timestamp - cached.fetchedAt <= retainMs) return { data: cached.data as T, fetchedAt: cached.fetchedAt, stale: true }
      throw new Error('官方 API 请求退避中，且没有可用的近期缓存')
    }
    const pending = inFlight.get(key)
    if (pending) return pending as Promise<OfficialResponse<T>>

    const run = (async (): Promise<OfficialResponse<unknown>> => {
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const release = await acquire()
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          try {
            const response = await fetcher(`${API_BASE}${path}`, {
              headers: { Accept: 'application/json', 'User-Agent': 'iota-miner-tools/0.1.0' },
              signal: controller.signal,
            })
            if (!response.ok) throw new Error(`官方 API 返回 HTTP ${response.status}`)
            const parsed = parseOfficialPayload(path, await response.json())
            const fetchedAt = now()
            cache.set(key, { data: parsed, fetchedAt, retryAt: 0, failures: 0 })
            failureBackoff.delete(key)
            return { data: parsed, fetchedAt, stale: false }
          } finally {
            clearTimeout(timer)
          }
        } catch (error) {
          lastError = error
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200))
        } finally {
          release()
        }
      }

      const failedAt = now()
      const prior = cache.get(key)
      const failures = (prior?.failures ?? failureBackoff.get(key)?.failures ?? 0) + 1
      const backoffMs = Math.min(30_000, 500 * 2 ** (failures - 1))
      failureBackoff.set(key, { failures, retryAt: failedAt + backoffMs })
      if (prior) cache.set(key, { ...prior, failures, retryAt: failedAt + backoffMs })
      if (prior && failedAt - prior.fetchedAt <= retainMs) {
        return { data: prior.data, fetchedAt: prior.fetchedAt, stale: true }
      }
      throw lastError instanceof Error ? lastError : new Error('官方 API 请求失败')
    })()

    inFlight.set(key, run)
    try {
      return await run as OfficialResponse<T>
    } finally {
      inFlight.delete(key)
    }
  }

  async function lookupMiner(minerId: string, knownRuns?: OfficialResponse<OfficialRuns>): Promise<OfficialLookup> {
    const checkedAt = now()
    if (!validateMinerId(minerId).valid) throw new Error('Miner ID 无效')

    let runsResponse: OfficialResponse<OfficialRuns>
    try {
      runsResponse = knownRuns ?? await request('/runs')
    } catch {
      return {
        status: 'unknown', miner: null, runId: null, checkedAt,
        lastSuccessfulFetchAt: null, coverage: { successful: 0, total: 0 }, stale: false,
        warning: '训练任务列表获取失败，无法确认 Miner ID 状态。',
      }
    }

    const activeRuns: DiscoveryRun[] = runsResponse.data.runs.filter((run) => run.state.toLowerCase() === 'active')
    const rosterResults = await Promise.allSettled(activeRuns.map((run) => request<OfficialMinerList>(`/miners?run_id=${encodeURIComponent(run.run_id)}`)))
    const successful = rosterResults.flatMap((result, index) => result.status === 'fulfilled'
      ? [{ runId: activeRuns[index]!.run_id, response: result.value }]
      : [])
    const complete = successful.length === activeRuns.length
    const matches = successful.flatMap(({ runId, response }) => {
      const miner = response.data.miners.find((entry) => entry.hotkey === minerId)
      return miner ? [{ runId, miner, response }] : []
    })
    matches.sort((a, b) => (b.miner.timestamp ?? 0) - (a.miner.timestamp ?? 0) || Number(b.miner.is_active) - Number(a.miner.is_active))

    const responseClocks = [runsResponse.fetchedAt, ...successful.map((item) => item.response.fetchedAt)]
    const lastSuccessfulFetchAt = complete && responseClocks.length > 0 ? Math.min(...responseClocks) : null
    const stale = runsResponse.stale || successful.some((item) => item.response.stale)
    const coverage = { successful: successful.length, total: activeRuns.length }
    const latest = matches[0]
    const sample = latest ? toSample(latest.runId, latest.miner) : null
    const runId = latest?.runId ?? null

    if (!complete) {
      return {
        status: 'unknown', miner: sample, runId, checkedAt, lastSuccessfulFetchAt, coverage, stale,
        warning: '部分训练任务名单未能读取，不能据此判断 Miner ID 离线或未注册。',
      }
    }
    if (lastSuccessfulFetchAt !== null && now() - lastSuccessfulFetchAt > INTERRUPTED_MS) {
      return {
        status: 'refresh_interrupted', miner: sample, runId, checkedAt, lastSuccessfulFetchAt, coverage, stale: true,
        warning: '超过 5 分钟没有成功获取完整官方名单，显示的是上一次成功读取的数据。',
      }
    }
    if (latest) {
      return {
        status: statusFor(latest.miner), miner: sample, runId, checkedAt, lastSuccessfulFetchAt, coverage, stale,
        warning: stale ? '部分结果使用了上一次成功的官方数据。' : null,
      }
    }

    const rankResults = await Promise.allSettled(activeRuns.map((run) => request<{ rank: number | null }>(
      '/v1/epoch_miner_scores/runs/' + run.run_id + '/hotkeys/' + minerId + '/run_level_rank',
    )))
    const rankedRun = rankResults.flatMap((result, index) => result.status === 'fulfilled' && result.value.data.rank != null
      ? [activeRuns[index]!.run_id]
      : [])[0] ?? null
    if (rankedRun) {
      return {
        status: 'unknown', miner: null, runId: rankedRun, checkedAt, lastSuccessfulFetchAt, coverage, stale,
        warning: '排行榜中存在该 Miner ID，但当前任务名单没有对应记录，状态暂无法确认。',
      }
    }

    return {
      status: 'not_found', miner: null, runId: null, checkedAt, lastSuccessfulFetchAt, coverage, stale,
      warning: activeRuns.length === 0 ? '当前没有进行中的训练任务。' : null,
    }
  }

  async function queryDashboardDetails(runId: string, minerId: string): Promise<{
    metrics: OfficialMetrics
    throughput: OfficialThroughput
    tokens: OfficialTokens
  }> {
    const base = `/v1/epoch_miner_scores/runs/${runId}/hotkeys/${minerId}`
    const [metrics, throughput, tokens] = await Promise.all([
      request<OfficialMetrics>(`${base}/metrics?period=week`),
      request<OfficialThroughput>(`${base}/throughput?moving_average_window=3&period=week`),
      request<OfficialTokens>(`/miners/${minerId}/runs/${runId}/tokens?period=week`),
    ])
    return { metrics: metrics.data, throughput: throughput.data, tokens: tokens.data }
  }

  return { request, lookupMiner, queryDashboardDetails }
}

function toSample(runId: string, miner: ApiMiner): OfficialMinerSample {
  return {
    hotkey: miner.hotkey,
    runId,
    isActive: miner.is_active,
    throughput: miner.throughput ?? 0,
    activations: miner.activation_count ?? 0,
    sampleAt: miner.timestamp ?? null,
  }
}

function statusFor(miner: ApiMiner): OfficialStatus {
  if ((miner.throughput ?? 0) > 0) return 'contributing'
  return miner.is_active ? 'waiting' : 'idle'
}

export const officialClient = createOfficialClient()
