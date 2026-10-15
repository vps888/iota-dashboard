import { blake2b } from '@noble/hashes/blake2.js'
import { base58 } from '@scure/base'

type MinerSample = { hotkey: string; runId: string; isActive: boolean; throughput: number; activations: number; sampleAt: number | null }
type Lookup = { status: string; miner: MinerSample | null; runId: string | null; checkedAt: number; lastSuccessfulFetchAt: number | null; coverage: { successful: number; total: number }; stale: boolean; warning: string | null }
type ApiResponse = { data: any; fetchedAt: number; stale: boolean }
const BASE = 'https://iota-web.api.macrocosmos.ai/mainnet'
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
type RunsData = { runs: { run_id: string; state: string; metadata?: { model_name?: string; model_size?: string; description?: string } | null }[] }
export type RunTier = 'gold' | 'silver' | 'bronze' | 'other'
export interface NetworkRun { runId: string; tier: RunTier; tierLabel: string; description: string; model: string | null; modelSize: string | null; activeMiners: number; maxMiners: number; slotsRemaining: number }
type OccupancyData = { run_ids: string[]; active_miners: number[]; max_miners: number[]; slots_remaining: number[] }
type MinerListData = { miners: { hotkey: string; is_active: boolean; timestamp?: number; throughput?: number; activation_count?: number }[] }
type EarningsTotals = { total_amount_earned: number; total_amount_paid: number; total_amount_pending: number; total_amount_frozen: number; minimum_payout_amount: number }
type EarningsHistory = { timestamps: number[]; alpha_amounts: number[]; statuses: string[] }
const schemas: Record<string, (value: any) => boolean> = {
  '/runs': (v) => Array.isArray(v?.runs) && v.runs.every((x: any) => typeof x.run_id === 'string' && typeof x.state === 'string'),
  '/v1/runs_occupancy': (v) => ['run_ids','active_miners','max_miners','slots_remaining'].every((k) => Array.isArray(v?.[k])),
  '/miners': (v) => Array.isArray(v?.miners) && v.miners.every((x: any) => typeof x.hotkey === 'string' && typeof x.is_active === 'boolean'),
}
function allowed(path: string): boolean {
  if (path === '/runs' || path === '/v1/runs_occupancy') return true
  if (/^\/miners\?run_id=[A-Za-z0-9._-]{1,64}$/.test(path)) return true
  if (/^\/v1\/epoch_miner_scores\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/hotkeys\/[1-9A-HJ-NP-Za-km-z]{45,55}\/run_level_rank$/.test(path)) return true
  if (/^\/v1\/entitlements\/(totals|history)\/hotkey\/[1-9A-HJ-NP-Za-km-z]{45,55}$/.test(path)) return true
  if (/^\/v1\/epoch_miner_scores\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/hotkeys\/[1-9A-HJ-NP-Za-km-z]{45,55}\/(metrics\?period=week|throughput\?moving_average_window=3&period=week)$/.test(path)) return true
  if (/^\/miners\/[1-9A-HJ-NP-Za-km-z]{45,55}\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/tokens\?period=week$/.test(path)) return true
  return false
}

export function tierFromDescription(description: string | null | undefined): RunTier {
  const text = description?.toLowerCase() ?? ''
  if (/\bgold\b|金/.test(text)) return 'gold'
  if (/\bsilver\b|银/.test(text)) return 'silver'
  if (/\bbronze\b|铜/.test(text)) return 'bronze'
  return 'other'
}
export const RUN_TIER_ORDER: Record<RunTier, number> = { gold: 0, silver: 1, bronze: 2, other: 3 }
export function sortNetworkRuns<T extends { tier: RunTier; runId: string }>(runs: T[]): T[] {
  return [...runs].sort((a, b) => RUN_TIER_ORDER[a.tier] - RUN_TIER_ORDER[b.tier] || a.runId.localeCompare(b.runId))
}
function validMiner(id: string): boolean {
  try {
    const raw = base58.decode(id)
    if (![35,36].includes(raw.length)) return false
    const first = raw[0]!
    const prefixLength = first < 64 ? 1 : 2
    const prefix = prefixLength === 1 ? first : ((first & 63) << 2) | (raw[1]! >> 6) | ((raw[1]! & 63) << 8)
    if (prefix !== 42 || raw.length - prefixLength !== 34) return false
    const checksum = blake2b(new Uint8Array([...new TextEncoder().encode('SS58PRE'), ...raw.subarray(0, raw.length - 2)]), { dkLen: 64 })
    return checksum[0] === raw[raw.length - 2] && checksum[1] === raw[raw.length - 1]
  } catch { return false }
}
export function createOfficialClient() {
  const cache = new Map<string, { data: any; at: number }>()
  async function request<T = any>(path: string): Promise<{ data: T; fetchedAt: number; stale: boolean }> {
    if (!allowed(path)) throw new Error('不允许的官方 API 路径')
    const cached = cache.get(path)
    if (cached && Date.now() - cached.at < 60_000) return { data: cached.data as T, fetchedAt: cached.at, stale: false }
    const response = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`官方 API HTTP ${response.status}`)
    const data = await response.json()
    const checker = path.startsWith('/miners?') ? schemas['/miners'] : schemas[path]
    if (checker && !checker(data)) throw new Error('官方数据格式异常')
    const at = Date.now()
    cache.set(path, { data, at })
    return { data: data as T, fetchedAt: at, stale: false }
  }

  async function networkRuns(): Promise<NetworkRun[]> {
    const [occupancy, runMeta] = await Promise.all([
      request<OccupancyData>('/v1/runs_occupancy'),
      request<RunsData>('/runs'),
    ])
    const metadata = new Map(runMeta.data.runs.map((run) => [run.run_id, run]))
    const runs = occupancy.data.run_ids.map((runId, i) => {
      const meta = metadata.get(runId)
      const description = meta?.metadata?.description ?? ''
      const tier = tierFromDescription(description)
      return {
        runId, tier, tierLabel: tier === 'other' ? '未分类' : ({ gold: '金', silver: '银', bronze: '铜' } as const)[tier],
        description, model: meta?.metadata?.model_name ?? null, modelSize: meta?.metadata?.model_size ?? null,
        activeMiners: occupancy.data.active_miners[i] ?? 0, maxMiners: occupancy.data.max_miners[i] ?? 0,
        slotsRemaining: occupancy.data.slots_remaining[i] ?? 0,
      }
    })
    return sortNetworkRuns(runs)
  }
  async function lookupMiner(minerId: string): Promise<Lookup> {
    if (!validMiner(minerId)) throw new Error('Miner ID 无效')
    const checkedAt = Date.now()
    let runs: { data: RunsData; fetchedAt: number; stale: boolean }
    try { runs = await request<RunsData>('/runs') } catch { return { status: 'unknown', miner: null, runId: null, checkedAt, lastSuccessfulFetchAt: null, coverage: { successful: 0, total: 0 }, stale: false, warning: '官方训练任务列表获取失败' } }
    const active = runs.data.runs.filter((r) => r.state.toLowerCase() === 'active')
    const results = await Promise.allSettled(active.map((r) => request<MinerListData>(`/miners?run_id=${encodeURIComponent(r.run_id)}`)))
    const successful = results.flatMap((r, i) => r.status === 'fulfilled' ? [{ run: active[i], response: r.value }] : [])
    const matches = successful.flatMap(({ run, response }) => {
      const m = response.data.miners.find((x) => x.hotkey === minerId)
      return m ? [{ run, response, miner: m }] : []
    }).sort((a, b) => (b.miner.timestamp ?? 0) - (a.miner.timestamp ?? 0))
    const latest = matches[0]
    const coverage = { successful: successful.length, total: active.length }
    return {
      status: successful.length !== active.length ? 'unknown' : latest ? ((latest.miner.throughput ?? 0) > 0 ? 'contributing' : latest.miner.is_active ? 'waiting' : 'idle') : active.length ? 'not_found' : 'idle',
      miner: latest ? { hotkey: minerId, runId: latest.run.run_id, isActive: latest.miner.is_active, throughput: latest.miner.throughput ?? 0, activations: latest.miner.activation_count ?? 0, sampleAt: latest.miner.timestamp ?? null } : null,
      runId: latest?.run.run_id ?? null, checkedAt,
      lastSuccessfulFetchAt: successful.length === active.length ? Math.min(runs.fetchedAt, ...successful.map((r) => r.response.fetchedAt)) : null,
      coverage, stale: false, warning: successful.length !== active.length ? '部分官方任务名单读取失败，状态待确认' : null,
    }
  }
  async function queryDashboardDetails(runId: string, minerId: string): Promise<{
    metrics: { epochs: number[]; token_counts: number[]; act_contribution_percs: number[]; activation_ranks: number[]; num_hotkeys_in_epochs: number[]; uploaded_partition_percs: number[]; weight_uploaded: number[]; timestamps: number[]; states?: string[] }
    throughput: { epochs: number[]; throughputs: number[]; throughput_moving_avgs: number[]; timestamps: number[] }
    tokens: { data_points: { timestamp: number; token_count: number; network_tokens: number; contribution_fraction: number }[] }
  }> {
    const [metrics, throughput, tokens] = await Promise.all([
      request<{ epochs: number[]; token_counts: number[]; act_contribution_percs: number[]; activation_ranks: number[]; num_hotkeys_in_epochs: number[]; uploaded_partition_percs: number[]; weight_uploaded: number[]; timestamps: number[]; states?: string[] }>(`/v1/epoch_miner_scores/runs/${runId}/hotkeys/${minerId}/metrics?period=week`),
      request<{ epochs: number[]; throughputs: number[]; throughput_moving_avgs: number[]; timestamps: number[] }>(`/v1/epoch_miner_scores/runs/${runId}/hotkeys/${minerId}/throughput?moving_average_window=3&period=week`),
      request<{ data_points: { timestamp: number; token_count: number; network_tokens: number; contribution_fraction: number }[] }>(`/miners/${minerId}/runs/${runId}/tokens?period=week`),
    ])
    return { metrics: metrics.data, throughput: throughput.data, tokens: tokens.data }
  }
  return { request, networkRuns, lookupMiner, queryDashboardDetails }
}
