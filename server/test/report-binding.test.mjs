import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validMinerId } from '../../packages/iota-miner-tools/test/fixtures.mjs'
import { createMacMinerServer } from '../../dist/server/server/index.js'
import { SqliteKV } from '../../dist/server/server/sqlite-kv.js'

const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const constant = 0x2bc830a3
function polymod(values) {
  let checksum = 1
  for (const value of values) {
    const top = checksum >>> 25
    checksum = (((checksum & 0x1ffffff) << 5) ^ value) >>> 0
    for (let index = 0; index < generators.length; index += 1) {
      if (((top >>> index) & 1) !== 0) checksum = (checksum ^ generators[index]) >>> 0
    }
  }
  return checksum >>> 0
}
function testNoidAddress() {
  const payload = Array.from({ length: 32 }, (_, index) => (index * 11) % 32)
  const prefix = [3, 0, 15]
  const residue = (polymod([...prefix, ...payload, 0, 0, 0, 0, 0, 0]) ^ constant) >>> 0
  const checksum = [25, 20, 15, 10, 5, 0].map((shift) => (residue >>> shift) & 31)
  return `o1${[...payload, ...checksum].map((value) => alphabet[value]).join('')}`
}

test('token pairing stores IOTA and NOID local reports under separate public identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mac-miner-binding-'))
  const webRoot = join(directory, 'web')
  await mkdir(webRoot)
  const databasePath = join(directory, 'state.sqlite')
  const address = testNoidAddress()
  const originalFetch = globalThis.fetch
  const clientFetch = originalFetch.bind(globalThis)
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname.endsWith('/payments')) {
      return Response.json({
        coin: 'parano1d', address, page: 0, pageSize: 100, total: 1, hasMore: false,
        rows: [{ amount: '50000000', txid: 'test-tx', status: 'confirmed', created_at: '2026-10-08T10:00:00.000Z' }],
      })
    }
    return Response.json({
      coin: 'parano1d', address, found: true, hashrate: 1200000, hashrate_unit: 'H/s', workersOnline: 1,
      workers: [{ worker: 'private-label', hashrate: 1200000, accepted: 10, rejected: 0, stale: 0, online: true, lastSeenAgo: 0 }],
      shares: { accepted10m: '10', accepted1h: '10', accepted24h: '10' },
      balance: { pending: '0', confirmed: '50000000', paid: '0' },
      payout: { minPayout: '50000000', remaining: '0' },
    })
  }

  const app = createMacMinerServer(databasePath, webRoot)
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  const serverAddress = app.server.address()
  assert.ok(serverAddress && typeof serverAddress === 'object')
  const origin = `http://127.0.0.1:${serverAddress.port}`

  try {
    const invalidAddress = await clientFetch(`${origin}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ miner: validMinerId, noidAddress: 'o1invalid' }),
    })
    assert.equal(invalidAddress.status, 400)

    const tokenResponse = await clientFetch(`${origin}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ miner: validMinerId, noidAddress: address }),
    })
    assert.equal(tokenResponse.status, 200)
    const { token } = await tokenResponse.json()

    const report = {
      status: 'training', description: 'local test', queuePosition: null, controlConnected: true,
      restarts: 0, uptimeSec: 30, reportedAt: Math.floor(Date.now() / 1000), os: 'macos', agentVersion: 'test',
      noid: { mode: 'training', running: true, cpuDuty: 10, gpuDuty: 10, cpuRate: 500000, gpuRate: 800000, accepted: 10, rejected: 0, stale: 0 },
    }
    const reportResponse = await clientFetch(`${origin}/api/local-report`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(report),
    })
    assert.equal(reportResponse.status, 200)

    const noidResponse = await clientFetch(`${origin}/api/noid?address=${encodeURIComponent(address)}`)
    assert.equal(noidResponse.status, 200)
    const noidData = await noidResponse.json()
    assert.equal(noidData.localScheduler.snapshot.cpuDuty, 10)
    assert.equal(noidData.payments[0].txid, 'test-tx')
    assert.equal('miner' in noidData, false)
    assert.equal('lookup' in noidData, false)
  } finally {
    globalThis.fetch = originalFetch
    await app.stop()
  }

  const persisted = new SqliteKV(databasePath)
  try {
    const iotaReport = await persisted.get(`local-report:${validMinerId}`, 'json')
    const noidReport = await persisted.get(`local-report-noid:${address}`, 'json')
    assert.equal('noid' in iotaReport, false)
    assert.equal(noidReport.noid.cpuDuty, 10)
  } finally {
    persisted.close()
    await rm(directory, { recursive: true, force: true })
  }
})
