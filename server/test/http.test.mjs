import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMacMinerServer } from '../../dist/server/server/index.js'

test('Node adapter serves static assets and keeps project APIs isolated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mac-miner-http-'))
  const webRoot = join(directory, 'web')
  await mkdir(webRoot)
  await writeFile(join(webRoot, 'index.html'), '<title>mac-miner test</title>')
  const { server, stop } = createMacMinerServer(join(directory, 'state.sqlite'), webRoot)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const page = await fetch(`${origin}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /mac-miner test/)

    const iota = await fetch(`${origin}/api/dashboard?miner=invalid`)
    assert.equal(iota.status, 400)
    assert.equal((await iota.json()).code, 'invalid_miner_id')

    const noid = await fetch(`${origin}/api/noid?address=invalid`)
    assert.equal(noid.status, 400)
    assert.equal((await noid.json()).code, 'invalid_noid_address')

    const unknown = await fetch(`${origin}/api/not-a-route`)
    assert.equal(unknown.status, 404)
    const apiUnknown = await fetch(`${origin}/api/not-a-route`)
    assert.equal(apiUnknown.status, 404)
  } finally {
    await stop()
    await rm(directory, { recursive: true, force: true })
  }
})
