import {
  isValidNoidAddress,
  normalizeNoidPayments,
  normalizeNoidPoolSnapshot,
  type NoidPayment,
  type NoidPoolSnapshot,
} from '../../packages/iota-miner-tools/src/noid.js'
import type { LocalReportInput } from '../../packages/iota-miner-tools/src/schema.js'

export interface Env {
  CACHE?: KVNamespace
}

interface CachedNoidPayload extends NoidPoolSnapshot {
  address: string
  payments: NoidPayment[]
  fetchedAt: number
  paymentsWarning: string | null
}

interface NoidLocalReportRecord {
  noid: LocalReportInput['noid']
  reportedAtServer: number
}

interface NoidLocalReportView {
  snapshot: NonNullable<LocalReportInput['noid']> | null
  reportedAtServer: number
  stale: boolean
}

const NOID_API = 'https://noid.innovlab.cc/api/coins/parano1d/miner'
const POOL_CACHE_TTL_SEC = 30
const STALE_CACHE_TTL_SEC = 10 * 60
const PAYMENT_PAGE_SIZE = 100

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`NOID upstream HTTP ${response.status}`)
  return response.json()
}

async function localReport(address: string, env: Env): Promise<NoidLocalReportView | null> {
  const record = await env.CACHE?.get(`local-report-noid:${address}`, 'json') as NoidLocalReportRecord | null
  if (!record || typeof record.reportedAtServer !== 'number') return null
  return {
    snapshot: record.noid ?? null,
    reportedAtServer: record.reportedAtServer,
    stale: Math.floor(Date.now() / 1000) - record.reportedAtServer > 150,
  }
}

async function responseFor(payload: CachedNoidPayload, stale: boolean, warning: string | null, env: Env): Promise<Response> {
  return json({
    ...payload,
    stale,
    warning,
    localScheduler: await localReport(payload.address, env),
  })
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const address = new URL(request.url).searchParams.get('address')?.trim() ?? ''
  if (!isValidNoidAddress(address)) return json({ code: 'invalid_noid_address', message: 'NOID 收款地址格式无效' }, 400)

  const cacheKey = `noid-dashboard:v1:${address}`
  const cached = await env.CACHE?.get(cacheKey, 'json') as { payload: CachedNoidPayload; cachedAt: number } | null
  const cacheAge = cached ? Date.now() - cached.cachedAt : Number.POSITIVE_INFINITY
  if (cached && cacheAge < POOL_CACHE_TTL_SEC * 1000) {
    return responseFor(cached.payload, false, cached.payload.paymentsWarning, env)
  }
  const stalePayload = cached && cacheAge <= STALE_CACHE_TTL_SEC * 1000 ? cached.payload : null

  try {
    const encodedAddress = encodeURIComponent(address)
    const [overviewResult, paymentsResult] = await Promise.allSettled([
      fetchJson(`${NOID_API}/${encodedAddress}`),
      fetchJson(`${NOID_API}/${encodedAddress}/payments?page=0&pageSize=${PAYMENT_PAGE_SIZE}`),
    ])
    if (overviewResult.status === 'rejected') throw overviewResult.reason
    const pool = normalizeNoidPoolSnapshot(overviewResult.value, address)
    let payments: NoidPayment[] = []
    let paymentsWarning: string | null = null
    if (paymentsResult.status === 'fulfilled') {
      try {
        payments = normalizeNoidPayments(paymentsResult.value, address)
      } catch {
        paymentsWarning = '付款记录格式暂不可用，矿池状态仍已更新。'
      }
    } else {
      paymentsWarning = '付款记录暂时无法刷新，矿池状态仍已更新。'
    }

    const payload: CachedNoidPayload = {
      ...pool,
      address,
      payments,
      fetchedAt: Math.floor(Date.now() / 1000),
      paymentsWarning,
    }
    await env.CACHE?.put(cacheKey, JSON.stringify({ payload, cachedAt: Date.now() }), { expirationTtl: STALE_CACHE_TTL_SEC })
    return responseFor(payload, false, paymentsWarning, env)
  } catch {
    if (stalePayload) return responseFor(stalePayload, true, '矿池接口暂时不可用，显示最近一次成功读取的数据。', env)
    return json({ code: 'noid_upstream_unavailable', message: 'NOID 矿池暂时不可用，请稍后重试。' }, 502)
  }
}
