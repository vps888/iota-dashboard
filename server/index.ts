import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onRequestGet as dashboardGet } from '../functions/api/dashboard.js'
import { onRequestGet as noidGet } from '../functions/api/noid.js'
import { onRequestPost as tokenPost, onRequestDelete as tokenDelete } from '../functions/api/token.js'
import { onRequestPost as localReportPost } from '../functions/api/local-report.js'
import { SqliteKV } from './sqlite-kv.js'

type PagesHandler = (context: { request: Request; env: { CACHE: unknown } }) => Promise<Response>

const routes: Record<string, PagesHandler> = {
  'GET /api/dashboard': dashboardGet as unknown as PagesHandler,
  'GET /api/noid': noidGet as unknown as PagesHandler,
  'POST /api/token': tokenPost as unknown as PagesHandler,
  'DELETE /api/token': tokenDelete as unknown as PagesHandler,
  'POST /api/local-report': localReportPost as unknown as PagesHandler,
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

const MAX_REQUEST_BYTES = 16 * 1024
const PORT = parsePort(process.env.PORT ?? '8080')
const WEB_ROOT = resolve(process.env.MAC_MINER_WEB_ROOT ?? join(process.cwd(), 'dist', 'web'))
const DATABASE_PATH = process.env.MAC_MINER_DB_PATH ?? '/data/mac-miner.sqlite'

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535')
  return port
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(value))
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += data.byteLength
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('Request body too large'), { statusCode: 413 })
    chunks.push(data)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

async function toRequest(request: IncomingMessage, pathname: string): Promise<Request> {
  const headers = new Headers()
  for (const key of ['authorization', 'content-type', 'accept']) {
    const value = request.headers[key]
    if (typeof value === 'string') headers.set(key, value)
  }
  const method = request.method ?? 'GET'
  const init: RequestInit = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') init.body = Buffer.from(await readBody(request)).toString('utf8')
  return new Request(new URL(pathname, 'http://mac-miner.local'), init)
}

async function writeResponse(response: Response, output: ServerResponse): Promise<void> {
  output.statusCode = response.status
  response.headers.forEach((value, key) => output.setHeader(key, value))
  output.setHeader('x-content-type-options', 'nosniff')
  output.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
  output.end(Buffer.from(await response.arrayBuffer()))
}

async function serveStatic(pathname: string, response: ServerResponse, requestMethod: string, webRoot: string): Promise<void> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendJson(response, 400, { code: 'invalid_path', message: 'Invalid path' })
    return
  }
  const candidate = resolve(webRoot, `.${decoded}`)
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${sep}`)) {
    sendJson(response, 403, { code: 'forbidden_path', message: 'Forbidden' })
    return
  }
  const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(webRoot, 'index.html')
  if (!existsSync(file)) {
    sendJson(response, 503, { code: 'web_build_missing', message: 'Web assets are not built' })
    return
  }
  response.statusCode = 200
  response.setHeader('content-type', MIME_TYPES[extname(file)] ?? 'application/octet-stream')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
  response.setHeader('cache-control', extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable')
  if (requestMethod === 'HEAD') {
    response.end()
    return
  }
  createReadStream(file).pipe(response)
}

export function createMacMinerServer(databasePath = DATABASE_PATH, webRoot = WEB_ROOT) {
  const cache = new SqliteKV(databasePath)
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://mac-miner.local')
    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true, service: 'mac-miner' })
      return
    }
    const handler = routes[`${request.method ?? 'GET'} ${url.pathname}`]
    if (handler) {
      try {
        const webRequest = await toRequest(request, `${url.pathname}${url.search}`)
        const result = await handler({ request: webRequest, env: { CACHE: cache } })
        await writeResponse(result, response)
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 500
        sendJson(response, status >= 400 && status < 600 ? status : 500, {
          code: status === 413 ? 'payload_too_large' : 'internal_error',
          message: status === 413 ? '请求内容超过限制' : '服务器暂时无法处理请求',
        })
      }
      return
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { code: 'route_not_found', message: 'API route not found' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { code: 'method_not_allowed', message: 'Method not allowed' })
      return
    }
    await serveStatic(url.pathname, response, request.method ?? 'GET', webRoot)
  })

  const purgeTimer = setInterval(() => cache.purgeExpired(), 60_000)
  purgeTimer.unref()
  const stop = (): Promise<void> => new Promise((resolveClose) => {
    clearInterval(purgeTimer)
    server.close(() => {
      cache.close()
      resolveClose()
    })
  })
  return { server, stop }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077)
  const { server, stop } = createMacMinerServer()
  server.listen(PORT, '0.0.0.0', () => console.log(`mac-miner listening on ${PORT}`))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
