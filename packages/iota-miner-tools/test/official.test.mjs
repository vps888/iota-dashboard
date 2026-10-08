import test from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialClient } from '../dist/official.js'
import { validMinerId } from './fixtures.mjs'

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

function makeClient(responses, now = () => 1_800_000_000_000) {
  const paths = []
  const client = createOfficialClient({
    now,
    fetch: async (url) => {
      const path = new URL(url).pathname.replace('/mainnet', '') + new URL(url).search
      paths.push(path)
      const response = responses[path]
      if (response instanceof Error) throw response
      if (response?.status) return new Response('', { status: response.status })
      return json(response)
    },
  })
  return { client, paths }
}

test('finds a miner across every active run and reports complete coverage', async () => {
  const { client, paths } = makeClient({
    '/runs': { runs: [{ run_id: 'inactive', state: 'complete' }, { run_id: 'run-a', state: 'active' }, { run_id: 'run-b', state: 'active' }] },
    '/miners?run_id=run-a': { miners: [] },
    '/miners?run_id=run-b': { miners: [{ hotkey: validMinerId, is_active: true, timestamp: 1_799_999_900, throughput: 12, activation_count: 3 }] },
  })
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'contributing')
  assert.equal(result.runId, 'run-b')
  assert.deepEqual(result.coverage, { successful: 2, total: 2 })
  assert.equal(paths.filter((path) => path.startsWith('/miners?')).length, 2)
})

test('partial roster failure reports unknown rather than not found', async () => {
  const { client } = makeClient({
    '/runs': { runs: [{ run_id: 'run-a', state: 'active' }, { run_id: 'run-b', state: 'active' }] },
    '/miners?run_id=run-a': { miners: [] },
    '/miners?run_id=run-b': new Error('upstream unavailable'),
  })
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'unknown')
  assert.equal(result.coverage.successful, 1)
})

test('rejects malformed parallel-run data and does not confirm absence', async () => {
  const { client } = makeClient({
    '/runs': { runs: [{ run_id: 'run-a', state: 'active' }] },
    '/miners?run_id=run-a': { miners: 'not-an-array' },
  })
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'unknown')
})

test('confirms absence only after a complete roster scan', async () => {
  const { client } = makeClient({
    '/runs': { runs: [{ run_id: 'run-a', state: 'active' }] },
    '/miners?run_id=run-a': { miners: [] },
  })
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'not_found')
})

test('uses the last successful roster when refresh fails', async () => {
  let clock = 1_800_000_000_000
  let fail = false
  const client = createOfficialClient({
    now: () => clock,
    fetch: async (url) => {
      const path = new URL(url).pathname.replace('/mainnet', '') + new URL(url).search
      if (fail && path === '/miners?run_id=run-a') throw new Error('offline')
      if (path === '/runs') return json({ runs: [{ run_id: 'run-a', state: 'active' }] })
      if (path === '/miners?run_id=run-a') return json({ miners: [{ hotkey: validMinerId, is_active: false, timestamp: 1_799_999_900, throughput: 0 }] })
      throw new Error(`unexpected path ${path}`)
    },
  })
  assert.equal((await client.lookupMiner(validMinerId)).status, 'idle')
  fail = true
  clock += 61_000
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'idle')
  assert.equal(result.stale, true)
})


test('reports refresh interruption when cached roster data exceeds five minutes', async () => {
  let clock = 1_800_000_000_000
  let fail = false
  const client = createOfficialClient({
    now: () => clock,
    fetch: async (url) => {
      const path = new URL(url).pathname.replace('/mainnet', '') + new URL(url).search
      if (fail) throw new Error('offline')
      if (path === '/runs') return json({ runs: [{ run_id: 'run-a', state: 'active' }] })
      if (path === '/miners?run_id=run-a') return json({ miners: [{ hotkey: validMinerId, is_active: true, timestamp: 1_799_999_900, throughput: 1 }] })
      throw new Error('unexpected path')
    },
  })
  await client.lookupMiner(validMinerId)
  fail = true
  clock += 6 * 60_000
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'refresh_interrupted')
  assert.equal(result.stale, true)
})

test('reuses fresh cached API responses', async () => {
  let calls = 0
  const client = createOfficialClient({
    fetch: async (url) => {
      calls += 1
      const path = new URL(url).pathname.replace('/mainnet', '') + new URL(url).search
      if (path === '/runs') return json({ runs: [{ run_id: 'run-a', state: 'active' }] })
      if (path === '/miners?run_id=run-a') return json({ miners: [{ hotkey: validMinerId, is_active: false, timestamp: 1_799_999_900, throughput: 0 }] })
      throw new Error('unexpected path')
    },
  })
  await client.lookupMiner(validMinerId)
  await client.lookupMiner(validMinerId)
  assert.equal(calls, 2)
})

test('limits concurrent roster requests', async () => {
  let active = 0
  let maxActive = 0
  const runs = Array.from({ length: 8 }, (_, i) => ({ run_id: 'run-' + i, state: 'active' }))
  const client = createOfficialClient({
    concurrency: 3,
    fetch: async (url) => {
      const path = new URL(url).pathname.replace('/mainnet', '') + new URL(url).search
      if (path === '/runs') return json({ runs })
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return json({ miners: [] })
    },
  })
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'not_found')
  assert.equal(maxActive, 3)
})

test('returns unknown when the active-run list times out', async () => {
  const client = createOfficialClient({
    timeoutMs: 5,
    fetch: async (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'unknown')
})


test('backs off repeated failures when no stale response is available', async () => {
  let calls = 0
  const client = createOfficialClient({
    fetch: async () => {
      calls += 1
      throw new Error('upstream unavailable')
    },
  })
  assert.equal((await client.lookupMiner(validMinerId)).status, 'unknown')
  const callsAfterFirstQuery = calls
  assert.equal(callsAfterFirstQuery, 2)
  assert.equal((await client.lookupMiner(validMinerId)).status, 'unknown')
  assert.equal(calls, callsAfterFirstQuery)
})

test('does not call an inactive run roster when there are no active runs', async () => {
  const { client, paths } = makeClient({
    '/runs': { runs: [{ run_id: 'run-old', state: 'complete' }] },
  })
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'not_found')
  assert.deepEqual(result.coverage, { successful: 0, total: 0 })
  assert.deepEqual(paths, ['/runs'])
})

test('selects the newest sample when an ID appears in multiple runs', async () => {
  const { client } = makeClient({
    '/runs': { runs: [{ run_id: 'run-old', state: 'active' }, { run_id: 'run-new', state: 'active' }] },
    '/miners?run_id=run-old': { miners: [{ hotkey: validMinerId, is_active: true, timestamp: 1_799_999_000, throughput: 50 }] },
    '/miners?run_id=run-new': { miners: [{ hotkey: validMinerId, is_active: false, timestamp: 1_799_999_900, throughput: 0 }] },
  })
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.runId, 'run-new')
  assert.equal(result.status, 'idle')
})


test('keeps status unknown when rank conflicts with a complete roster scan', async () => {
  const { client } = makeClient({
    '/runs': { runs: [{ run_id: 'run-a', state: 'active' }] },
    '/miners?run_id=run-a': { miners: [] },
    ['/v1/epoch_miner_scores/runs/run-a/hotkeys/' + validMinerId + '/run_level_rank']: { rank: 2 },
  })
  const result = await client.lookupMiner(validMinerId)
  assert.equal(result.status, 'unknown')
  assert.equal(result.runId, 'run-a')
})
