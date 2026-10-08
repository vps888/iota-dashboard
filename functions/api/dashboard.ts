import { officialClient } from '../../packages/iota-miner-tools/src/official.js'
import { validateMinerId } from '../../packages/iota-miner-tools/src/ss58.js'
import type { OfficialRuns } from '../../packages/iota-miner-tools/src/schema.js'
const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=iota-2&vs_currencies=usd'

export interface Env {
  CACHE?: KVNamespace
}

async function api<T>(path: string): Promise<T> {
  return (await officialClient.request<T>(path)).data
}

// CoinGecko 免费接口按 IP 限流,Cloudflare 出口经常 429;
// 价格缓存 10 分钟,失败时沿用上次的值(stale 也比没有好)
let priceCache: { usd: number; at: number } | null = null
const PRICE_TTL_MS = 10 * 60_000

async function getUsdPrice(): Promise<number | null> {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.usd
  try {
    const r = await fetch(PRICE_URL, { headers: { 'User-Agent': 'iota-dashboard/1.0', Accept: 'application/json' } })
    if (r.ok) {
      const d = (await r.json()) as { 'iota-2'?: { usd?: number } }
      const usd = d['iota-2']?.usd
      if (typeof usd === 'number' && usd > 0) {
        priceCache = { usd, at: Date.now() }
        return usd
      }
    }
  } catch {}
  return priceCache?.usd ?? null
}

function shortId(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-6)}`
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const hotkey = new URL(request.url).searchParams.get('miner')?.trim() ?? ''
  if (!validateMinerId(hotkey).valid) {
    return new Response(JSON.stringify({ code: 'invalid_miner_id', message: 'Miner ID 格式无效(应为 SS58 hotkey)' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  const cacheKey = `dashboard:v2:${hotkey}`
  const cached = await env.CACHE?.get(cacheKey, 'json') as { payload: unknown; cachedAt: number } | null
  const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity
  if (cached && cacheAge < 60_000) {
    return json(await withLocalReport(cached.payload, hotkey, env), true)
  }
  const stalePayload = cached && cacheAge <= 10 * 60_000 ? cached.payload : null

  const settled = await Promise.allSettled([
    api('/v1/runs_occupancy') as Promise<{ run_ids: string[]; max_miners: number[]; active_miners: number[]; slots_remaining: number[] }>,
    officialClient.request<OfficialRuns>('/runs'),
    api(`/v1/entitlements/totals/hotkey/${hotkey}`) as Promise<{ total_amount_earned: number; total_amount_paid: number; total_amount_pending: number; total_amount_frozen: number; minimum_payout_amount: number }>,
    api(`/v1/entitlements/history/hotkey/${hotkey}`) as Promise<{ timestamps: number[]; alpha_amounts: number[]; statuses: string[] }>,
    getUsdPrice(),
  ])
  const [occupancyR, runsMetaR, totalsR, historyR, priceRes] = settled
  if (occupancyR.status === 'rejected') {
    if (stalePayload) return staleDashboardResponse(await withLocalReport(stalePayload, hotkey, env))
    throw new Error('runs_occupancy failed')
  }

  const occupancy = occupancyR.status === 'fulfilled' ? occupancyR.value : { run_ids: [] as string[], max_miners: [] as number[], active_miners: [] as number[], slots_remaining: [] as number[] }
  const metaByRun = new Map((runsMetaR.status === 'fulfilled' ? runsMetaR.value.data.runs : []).map((r) => [r.run_id, r]))
  // description 形如 "1B - Tier 0 (Bronze)";tier 取括号内的档位名
  const tierOf = (runId: string): string | null => {
    const desc = metaByRun.get(runId)?.metadata?.description ?? ''
    const m = /\(([^)]+)\)/.exec(desc)
    return m?.[1] ?? null
  }
  const totals = totalsR.status === 'fulfilled' ? totalsR.value : { total_amount_earned: 0, total_amount_paid: 0, total_amount_pending: 0, total_amount_frozen: 0, minimum_payout_amount: 0 }
  const history = historyR.status === 'fulfilled' ? historyR.value : { timestamps: [] as number[], alpha_amounts: [] as number[], statuses: [] as string[] }

  const runs = occupancy.run_ids.map((runId, i) => {
    const meta = metaByRun.get(runId)
    return {
      runId,
      tier: tierOf(runId),
      model: meta?.metadata?.model_name ?? null,
      modelSize: meta?.metadata?.model_size ?? null,
      maxMiners: occupancy.max_miners[i],
      activeMiners: occupancy.active_miners[i],
      slotsRemaining: occupancy.slots_remaining[i],
    }
  })

  const officialLookup = runsMetaR.status === 'fulfilled'
    ? await officialClient.lookupMiner(hotkey, runsMetaR.value)
    : {
        status: 'unknown' as const,
        miner: null,
        runId: null,
        checkedAt: Date.now(),
        lastSuccessfulFetchAt: null,
        coverage: { successful: 0, total: 0 },
        stale: false,
        warning: '训练任务列表获取失败，无法确认 Miner ID 状态。',
      }
  const membership = officialLookup.miner

  const hkNow = new Date(Date.now() + 8 * 3600_000)
  const hkMidnightUTC = Date.UTC(hkNow.getUTCFullYear(), hkNow.getUTCMonth(), hkNow.getUTCDate()) / 1000 - 8 * 3600
  const historyEntries = history.timestamps
    .map((ts, i) => ({ ts, amount: history.alpha_amounts[i] ?? 0, status: history.statuses[i] ?? 'unknown' }))
  const yesterdayEarnedUnits = historyEntries
    .filter((e) => e.ts >= hkMidnightUTC - 86400 && e.ts < hkMidnightUTC)
    .reduce((s, e) => s + e.amount, 0)

  let miner: object | null = null
  let todayEarnedUnits = 0
  if (officialLookup.runId) {
    const runId = officialLookup.runId
    type Metrics = {
      epochs: number[]; token_counts: number[]; act_contribution_percs: number[]; activation_ranks: number[]; num_hotkeys_in_epochs: number[]; uploaded_partition_percs: number[]; weight_uploaded: number[]; timestamps: number[]
    }
    type Throughput = {
      epochs: number[]; throughputs: number[]; throughput_moving_avgs: number[]; timestamps: number[]
    }
    type Tokens = {
      data_points: { timestamp: number; token_count: number; network_tokens: number; contribution_fraction: number }[]
    }
    const detail = await Promise.allSettled([
      api(`/v1/epoch_miner_scores/runs/${runId}/hotkeys/${hotkey}/metrics?period=week`) as Promise<Metrics>,
      api(`/v1/epoch_miner_scores/runs/${runId}/hotkeys/${hotkey}/throughput?moving_average_window=3&period=week`) as Promise<Throughput>,
      api(`/miners/${hotkey}/runs/${runId}/tokens?period=week`) as Promise<Tokens>,
    ])
    if (detail.some((d) => d.status === 'rejected')) {
      if (stalePayload) return staleDashboardResponse(stalePayload)
      throw new Error('miner detail failed')
    }
    const metrics = (detail[0] as PromiseFulfilledResult<Metrics>).value
    const throughput = (detail[1] as PromiseFulfilledResult<Throughput>).value
    const tokens = (detail[2] as PromiseFulfilledResult<Tokens>).value

    const last = metrics.epochs.length - 1
    const lastThr = throughput.epochs.length - 1
    const latestPoint = tokens.data_points.length ? tokens.data_points[tokens.data_points.length - 1] : null
    const online = membership?.isActive ?? null
    const training = membership ? online === true && latestPoint !== null && latestPoint !== undefined && latestPoint.token_count > 0 : null

    // 最后一次有 token 产出的采样时间
    const lastProductivePoint = [...tokens.data_points].reverse().find((p) => p.token_count > 0)

    // uploaded_partition_percs 是分区编号(0..n_splits-1),不是百分比;
    // n_splits=3 时 0/1/2 对应 L0/L1/L2
    const latestPartitionIdx = last >= 0 ? metrics.uploaded_partition_percs[last] ?? null : null
    const partitionLabel = latestPartitionIdx !== null && Number.isFinite(latestPartitionIdx)
      ? `第 ${latestPartitionIdx + 1} 段 (L${latestPartitionIdx})`
      : null

    const epochRecords = metrics.epochs
      .map((epoch, i) => ({
        epoch,
        ts: metrics.timestamps[i] ?? 0,
        tokens: metrics.token_counts[i] ?? 0,
        rank: metrics.activation_ranks[i] ?? null,
        numHotkeys: metrics.num_hotkeys_in_epochs[i] ?? null,
        contribution: metrics.act_contribution_percs[i] ?? null,
      }))
      .filter((r) => r.tokens > 0)
      .sort((a, b) => b.ts - a.ts)

    // “今日”按香港时间(官方结算时区)0 点起算
    const todayEntries = historyEntries.filter((e) => e.ts >= hkMidnightUTC)
    todayEarnedUnits = todayEntries.reduce((s, e) => s + e.amount, 0)

    miner = {
      hotkey,
      shortId: shortId(hotkey),
      name: shortId(hotkey),
      runId,
      online,
      training,
      tokensPerActivation: 3200,
      throughput: membership?.throughput ?? (lastThr >= 0 ? throughput.throughputs[lastThr] ?? 0 : 0),
      throughputAvg: lastThr >= 0 ? throughput.throughput_moving_avgs[lastThr] ?? 0 : 0,
      activations: membership?.activations ?? (last >= 0 ? (metrics.token_counts[last] ?? 0) / 3200 : 0),
      tokens: last >= 0 ? metrics.token_counts[last] ?? 0 : 0,
      partitionLabel,
      lastContributionAt: lastProductivePoint?.timestamp ?? null,
      epochRecords,
      weightUploaded: last >= 0 ? metrics.weight_uploaded[last] ?? 0 : 0,
      latestSampleAt: membership?.sampleAt ?? (last >= 0 ? metrics.timestamps[last] ?? null : null),
      trainingPoints: tokens.data_points
        .filter((p) => p.token_count > 0)
        .map((p) => ({ ts: p.timestamp, tokens: p.token_count, networkTokens: p.network_tokens, contribution: p.contribution_fraction })),
    }
  }

  const payments = history.timestamps
    .map((ts, i) => ({ ts, amount: history.alpha_amounts[i] ?? 0, status: history.statuses[i] ?? 'unknown' }))
    .sort((a, b) => b.ts - a.ts)

  const usdPerIota = priceRes.status === 'fulfilled' ? priceRes.value : null

  const payload = {
    fetchedAt: Math.floor(Date.now() / 1000),
    lookup: {
      status: officialLookup.status,
      checkedAt: Math.floor(officialLookup.checkedAt / 1000),
      lastSuccessfulFetchAt: officialLookup.lastSuccessfulFetchAt === null ? null : Math.floor(officialLookup.lastSuccessfulFetchAt / 1000),
      coverage: officialLookup.coverage,
      stale: officialLookup.stale,
      warning: officialLookup.warning,
      sampleAt: officialLookup.miner?.sampleAt ?? null,
    },
    miner,
    todayEarned: todayEarnedUnits,
    yesterdayEarned: yesterdayEarnedUnits,
    totals: {
      earned: totals.total_amount_earned,
      paid: totals.total_amount_paid,
      pending: totals.total_amount_pending,
      frozen: totals.total_amount_frozen,
      minimumPayout: totals.minimum_payout_amount,
    },
    payments,
    runs,
    usdPerIota,
  }

  if (env.CACHE) await env.CACHE.put(cacheKey, JSON.stringify({ payload, cachedAt: Date.now() }), { expirationTtl: 600 })
  return json(await withLocalReport(payload, hotkey, env), false)
}

interface LocalReportRecord {
  status: string
  description: string
  queuePosition: number | null
  controlConnected: boolean
  restarts: number
  uptimeSec: number
  reportedAt: number
  os: string
  agentVersion: string
  hotkey: string
  reportedAtServer: number
}

// 本地上报每次读取时附加,不进 60 秒缓存,否则离线检测会滞后
async function withLocalReport(payload: unknown, hotkey: string, env: Env): Promise<unknown> {
  const record = await env.CACHE?.get(`local-report:${hotkey}`, 'json') as LocalReportRecord | null
  if (!record || typeof record.reportedAtServer !== 'number') return { ...(payload as object), localReport: null }
  return {
    ...(payload as object),
    localReport: {
      status: record.status,
      description: record.description,
      queuePosition: record.queuePosition ?? null,
      controlConnected: record.controlConnected,
      restarts: record.restarts,
      uptimeSec: record.uptimeSec,
      os: record.os,
      agentVersion: record.agentVersion,
      reportedAt: record.reportedAt,
      reportedAtServer: record.reportedAtServer,
      stale: Math.floor(Date.now() / 1000) - record.reportedAtServer > 150,
    },
  }
}

function staleDashboardResponse(payload: unknown): Response {
  if (!payload || typeof payload !== 'object') throw new Error('cached dashboard payload invalid')
  const data = payload as { lookup?: Record<string, unknown> }
  const lastSuccessfulFetchAt = typeof data.lookup?.lastSuccessfulFetchAt === 'number' ? data.lookup.lastSuccessfulFetchAt : null
  const refreshInterrupted = lastSuccessfulFetchAt === null || Date.now() / 1000 - lastSuccessfulFetchAt > 5 * 60
  return json({
    ...data,
    lookup: {
      ...data.lookup,
      status: refreshInterrupted ? 'refresh_interrupted' : data.lookup?.status ?? 'unknown',
      stale: true,
      warning: '官方接口暂时不可用，显示的是最近一次成功读取的数据。',
    },
  }, true)
}

function json(data: unknown, cached: boolean): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30',
      'x-dashboard-cached': cached ? 'hit' : 'miss',
    },
  })
}
