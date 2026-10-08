import net from 'node:net'

const HOST = '127.0.0.1'
const PORT = 18010
const BACKEND_PORT = 8010
const HEADER_LIMIT = 65536
const BACKEND_WAIT_MS = 180_000

// 只转发 /health 和 /ws 到本机矿工;backend 未就绪时等待而非伪造健康响应
function handleClient(client: net.Socket): void {
  client.setTimeout(10_000)
  let request = Buffer.alloc(0)
  const onData = (chunk: Buffer): void => {
    request = Buffer.concat([request, chunk])
    if (request.includes('\r\n\r\n')) {
      client.off('data', onData)
      client.setTimeout(0)
      route(client, request)
    } else if (request.length > HEADER_LIMIT) {
      client.destroy()
    }
  }
  client.on('data', onData)
  client.on('timeout', () => client.destroy())
}

function route(client: net.Socket, request: Buffer): void {
  const line = request.subarray(0, request.indexOf('\r\n')).toString('latin1').split(' ')
  if (line.length !== 3 || line[0] !== 'GET') {
    client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    return
  }
  const path = line[1].split('?')[0]
  if (path !== '/health' && path !== '/ws') {
    client.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    return
  }
  const deadline = Date.now() + BACKEND_WAIT_MS
  const tryConnect = (): void => {
    const backend = net.connect(BACKEND_PORT, HOST)
    backend.once('connect', () => {
      // 原样转发请求(含认证头);不记录任何地址、头、认证或载荷
      backend.write(request)
      client.pipe(backend)
      backend.pipe(client)
      const cleanup = (): void => {
        client.destroy()
        backend.destroy()
      }
      client.once('close', cleanup)
      backend.once('close', cleanup)
      client.once('error', cleanup)
      backend.once('error', cleanup)
    })
    backend.once('error', () => {
      backend.destroy()
      if (Date.now() >= deadline) {
        client.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        return
      }
      // 客户端断开就停止等待
      if (client.destroyed) return
      setTimeout(tryConnect, 300)
    })
  }
  tryConnect()
}

export function startRelay(): net.Server {
  const server = net.createServer(handleClient)
  server.listen(PORT, HOST)
  return server
}

export const RELAY_PORT = PORT
