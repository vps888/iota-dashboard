import { localReportInput } from '../../packages/iota-miner-tools/src/schema.js'

export interface Env {
  CACHE?: KVNamespace
}

const MAX_BODY_BYTES = 4096
const REPORT_TTL_SEC = 600

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
  if (!env.CACHE) return json('kv_unavailable', '存储未配置,无法接收上报', 503)
  const auth = request.headers.get('authorization') ?? ''
  const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(auth)
  if (!match) return json('unauthorized', '缺少或格式错误的 Bearer 令牌', 401)

  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > MAX_BODY_BYTES) return json('payload_too_large', '上报内容过大', 413)

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json('payload_too_large', '上报内容过大', 413)

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return json('invalid_body', '请求体必须是 JSON', 400)
  }
  const parsed = localReportInput.safeParse(value)
  if (!parsed.success) return json('invalid_payload', '上报字段校验失败', 400)

  const record = await env.CACHE.get(`token:${await sha256Hex(match[1] ?? '')}`, 'json') as { hotkey?: unknown; noidAddress?: unknown } | null
  if (!record || typeof record.hotkey !== 'string') return json('unauthorized', '令牌无效或已过期', 401)

  const reportedAtServer = Math.floor(Date.now() / 1000)
  const { noid, ...iotaReport } = parsed.data
  await env.CACHE.put(`local-report:${record.hotkey}`, JSON.stringify({
    ...iotaReport,
    hotkey: record.hotkey,
    reportedAtServer,
  }), { expirationTtl: REPORT_TTL_SEC })
  if (typeof record.noidAddress === 'string') {
    await env.CACHE.put(`local-report-noid:${record.noidAddress}`, JSON.stringify({
      noid: noid ?? null,
      reportedAtServer,
    }), { expirationTtl: REPORT_TTL_SEC })
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
