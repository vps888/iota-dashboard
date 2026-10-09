import { validateMinerId } from '../../packages/iota-miner-tools/src/ss58.js'
import { isValidNoidAddress } from '../../packages/iota-miner-tools/src/noid.js'

export interface Env {
  CACHE?: KVNamespace
}

const TOKEN_TTL_SEC = 90 * 86400
const RATE_WINDOW_SEC = 60
const RATE_LIMIT = 5

function json(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.CACHE) return json('kv_unavailable', '存储未配置,无法生成令牌', 503)
  let body: { miner?: unknown; noidAddress?: unknown }
  try {
    body = await request.json()
  } catch {
    return json('invalid_body', '请求体必须是 JSON', 400)
  }
  const miner = typeof body.miner === 'string' ? body.miner.trim() : ''
  if (!validateMinerId(miner).valid) {
    return json('invalid_miner_id', 'Miner ID 格式无效(应为 SS58 hotkey)', 400)
  }
  const noidAddress = body.noidAddress === undefined ? undefined : typeof body.noidAddress === 'string' ? body.noidAddress.trim() : ''
  if (noidAddress !== undefined && !isValidNoidAddress(noidAddress)) {
    return json('invalid_noid_address', 'NOID 收款地址格式无效', 400)
  }

  // 尽力而为的软限流:60 秒窗口内最多生成 5 个
  const rlKey = `token-rl:${miner}`
  const rlRaw = await env.CACHE.get(rlKey, 'json') as { count?: number } | null
  const count = (typeof rlRaw?.count === 'number' ? rlRaw.count : 0) + 1
  await env.CACHE.put(rlKey, JSON.stringify({ count }), { expirationTtl: RATE_WINDOW_SEC })
  if (count > RATE_LIMIT) return json('rate_limited', '生成过于频繁,请一分钟后再试', 429)

  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const hash = await sha256Hex(token)
  await env.CACHE.put(`token:${hash}`, JSON.stringify({ hotkey: miner, ...(noidAddress ? { noidAddress } : {}), createdAt: Date.now() }), { expirationTtl: TOKEN_TTL_SEC })
  return new Response(JSON.stringify({ token, createdAt: Date.now() }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.CACHE) return json('kv_unavailable', '存储未配置,无法撤销令牌', 503)
  let body: { token?: unknown }
  try {
    body = await request.json()
  } catch {
    return json('invalid_body', '请求体必须是 JSON', 400)
  }
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (token.length < 20 || token.length > 128) return json('invalid_token', '令牌格式无效', 400)
  await env.CACHE.delete(`token:${await sha256Hex(token)}`)
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
