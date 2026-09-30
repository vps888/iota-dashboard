const API_BASE = 'https://iota-web.api.macrocosmos.ai/mainnet'
const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=iota-2&vs_currencies=usd'
const MINER_ID_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{45,55}$/

export interface Env {
  CACHE?: KVNamespace
}

async function api(path: string): Promise<unknown> {
  const res = await fetch(API_BASE + path, {
    headers: { 'User-Agent': 'iota-dashboard/1.0', Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`upstream ${res.status} for ${path}`)
  return res.json()
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

async function findMinerRun(hotkey: string, runIds: string[]): Promise<{ runId: string; rank: number | null; numHotkeys: number | null } | null> {
  const probes = await Promise.all(
    runIds.map(async (runId) => {
      try {
        const d = (await api(`/v1/epoch_miner_scores/runs/${runId}/hotkeys/${hotkey}/run_level_rank`)) as {
          rank: number | null
          num_hotkeys: number | null
        }
        if (d.rank !== null && d.rank !== undefined) return { runId, rank: d.rank, numHotkeys: d.num_hotkeys }
      } catch {}
      return null
    }),
  )
  return probes.find((p): p is { runId: string; rank: number; numHotkeys: number | null } => p !== null) ?? null
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const hotkey = new URL(request.url).searchParams.get('miner')?.trim() ?? ''
  if (!MINER_ID_PATTERN.test(hotkey)) {
    return new Response(JSON.stringify({ code: 'invalid_miner_id', message: 'Miner ID 格式无效(应为 SS58 hotkey)' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  const cacheKey = `dashboard:v1:${hotkey}`
  const cached = await env.CACHE?.get(cacheKey, 'json')
  if (cached) return json(cached, true)

  const settled = await Promise.allSettled([
    api('/v1/runs_occupancy') as Promise<{ run_ids: string[]; max_miners: number[]; active_miners: number[]; slots_remaining: number[] }>,
    api('/runs') as Promise<{ runs: { run_id: string; state: string; metadata?: { model_name?: string; model_size?: string; n_splits?: number; description?: string } }[] }>,
    api(`/v1/entitlements/totals/hotkey/${hotkey}`) as Promise<{ total_amount_earned: number; total_amount_paid: number; total_amount_pending: number; total_amount_frozen: number; minimum_payout_amount: number }>,
    api(`/v1/entitlements/history/hotkey/${hotkey}`) as Promise<{ timestamps: number[]; alpha_amounts: number[]; statuses: string[] }>,
    api('/v1/entitlements/next_payout_timestamp') as Promise<{ next_payout_time: number }>,
    getUsdPrice(),
  ])
  const [occupancyR, runsMetaR, totalsR, historyR, payoutR, priceRes] = settled
  if (occupancyR.status === 'rejected') throw new Error('runs_occupancy failed')

  const occupancy = occupancyR.status === 'fulfilled' ? occupancyR.value : { run_ids: [] as string[], max_miners: [] as number[], active_miners: [] as number[], slots_remaining: [] as number[] }
  const metaByRun = new Map((runsMetaR.status === 'fulfilled' ? runsMetaR.value.runs : []).map((r) => [r.run_id, r]))
  // description 形如 "1B - Tier 0 (Bronze)";tier 取括号内的档位名
  const tierOf = (runId: string): string | null => {
    const desc = metaByRun.get(runId)?.metadata?.description ?? ''
    const m = /\(([^)]+)\)/.exec(desc)
    return m?.[1] ?? null
  }
  const totals = totalsR.status === 'fulfilled' ? totalsR.value : { total_amount_earned: 0, total_amount_paid: 0, total_amount_pending: 0, total_amount_frozen: 0, minimum_payout_amount: 0 }
  const history = historyR.status === 'fulfilled' ? historyR.value : { timestamps: [] as number[], alpha_amounts: [] as number[], statuses: [] as string[] }
  const payoutTs = payoutR.status === 'fulfilled' ? payoutR.value : { next_payout_time: 0 }

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

  const membership = await findMinerRun(hotkey, occupancy.run_ids)

  let miner: object | null = null
  let todayEarnedUnits = 0
  if (membership) {
    const runId = membership.runId
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
    if (detail.some((d) => d.status === 'rejected')) throw new Error('miner detail failed')
    const metrics = (detail[0] as PromiseFulfilledResult<Metrics>).value
    const throughput = (detail[1] as PromiseFulfilledResult<Throughput>).value
    const tokens = (detail[2] as PromiseFulfilledResult<Tokens>).value

    const last = metrics.epochs.length - 1
    const lastThr = throughput.epochs.length - 1
    const latestPoint = tokens.data_points.length ? tokens.data_points[tokens.data_points.length - 1] : null
    const nowTs = Math.floor(Date.now() / 1000)
    // “在线”=最近 2 个采样点里有产出 token(采样间隔约 30-40 分钟);
    // 注册在 run 里不代表在线,只是保留名额
    const ONLINE_WINDOW_S = 3600
    const onlinePoints = tokens.data_points.filter((p) => p.token_count > 0 && nowTs - p.timestamp <= ONLINE_WINDOW_S)
    const online = onlinePoints.length > 0
    const training = online && latestPoint !== null && latestPoint !== undefined && latestPoint.token_count > 0

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
    const hkNow = new Date(Date.now() + 8 * 3600_000)
    const hkMidnightUTC = Date.UTC(hkNow.getUTCFullYear(), hkNow.getUTCMonth(), hkNow.getUTCDate()) / 1000 - 8 * 3600
    const todayEntries = history.timestamps
      .map((ts, i) => ({ ts, amount: history.alpha_amounts[i] ?? 0, status: history.statuses[i] ?? 'unknown' }))
      .filter((e) => e.ts >= hkMidnightUTC)
    const todayEarned = todayEntries.reduce((s, e) => s + e.amount, 0)
    todayEarnedUnits = todayEarned

    miner = {
      hotkey,
      shortId: shortId(hotkey),
      name: `Miner ${shortId(hotkey)}`,
      runId,
      online,
      training,
      tokensPerActivation: 3200,
      throughput: lastThr >= 0 ? throughput.throughputs[lastThr] ?? 0 : 0,
      throughputAvg: lastThr >= 0 ? throughput.throughput_moving_avgs[lastThr] ?? 0 : 0,
      activations: last >= 0 ? (metrics.token_counts[last] ?? 0) / 3200 : 0,
      tokens: last >= 0 ? metrics.token_counts[last] ?? 0 : 0,
      rank: last >= 0 ? metrics.activation_ranks[last] ?? null : null,
      numHotkeys: last >= 0 ? metrics.num_hotkeys_in_epochs[last] ?? null : null,
      contributionPerc: last >= 0 ? metrics.act_contribution_percs[last] ?? null : null,
      partitionLabel,
      epochRecords,
      weightUploaded: last >= 0 ? metrics.weight_uploaded[last] ?? 0 : 0,
      latestSampleAt: last >= 0 ? metrics.timestamps[last] ?? null : null,
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
    miner,
    todayEarned: todayEarnedUnits,
    totals: {
      earned: totals.total_amount_earned,
      paid: totals.total_amount_paid,
      pending: totals.total_amount_pending,
      frozen: totals.total_amount_frozen,
      minimumPayout: totals.minimum_payout_amount,
    },
    nextPayoutAt: payoutTs.next_payout_time,
    payments,
    runs,
    usdPerIota,
  }

  if (env.CACHE) await env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 })
  return json(payload, false)
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
