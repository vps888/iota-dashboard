import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteKV } from '../../dist/server/server/sqlite-kv.js'

test('SQLite KV preserves text/JSON values and expiration across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mac-miner-kv-'))
  const path = join(directory, 'state.sqlite')
  try {
    const first = new SqliteKV(path)
    await first.put('token:hash', JSON.stringify({ hotkey: 'public-id' }), { expirationTtl: 90 })
    await first.put('cache:value', 'cached')
    assert.deepEqual(await first.get('token:hash', 'json'), { hotkey: 'public-id' })
    assert.equal(await first.get('cache:value'), 'cached')
    first.close()

    const reopened = new SqliteKV(path)
    assert.deepEqual(await reopened.get('token:hash', 'json'), { hotkey: 'public-id' })
    await reopened.put('short-lived', 'temporary', { expirationTtl: 1 })
    assert.equal(reopened.purgeExpired(Date.now() + 2_000), 1)
    assert.equal(await reopened.get('short-lived'), null)
    await reopened.delete('cache:value')
    assert.equal(await reopened.get('cache:value'), null)
    reopened.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
