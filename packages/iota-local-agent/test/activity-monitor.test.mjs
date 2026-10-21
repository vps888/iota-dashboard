import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyEvidence, parseLogs } from '../dist/guardian.js'
import { resolveActivity, trackActivity, formatDuration, activityTiming } from '../dist/activity-monitor.js'
const base = { ...emptyEvidence(100), queueStartedAt: 110, queueUpdatedAt: 120, queueStatus: 'queued', queuePosition: 535 }
const resolve = (e = base, running = true) => resolveActivity('miner', e, running, 1000)

test('all six registration states including future raw states are supported', () => {
  for (const kind of ['queued', 'confirming', 'confirmed', 'processing', 'succeeded', 'failed', 'future_state']) {
    assert.equal(resolve({ ...base, queueStatus: kind }).kind, kind)
  }
  assert.equal(resolve().queuePosition, 535)
  assert.equal(resolve(base, false).kind, 'stopped')
  assert.equal(resolve(emptyEvidence(100)), null)
})
test('training ticks normalize; explicit phase events and registration transitions are ordered', () => {
  let evidence = parseLogs([{ t: 130, line: "training.state accepted {\n state: 'layer_state_change',\n detail: 'Miner is moving state from LayerPhase.TRAINING to LayerPhase.WEIGHTS_UPLOADING',\n runId: 'run1'\n}" }], base)
  assert.equal(resolve(evidence).kind, 'weights_uploading')
  assert.equal(resolve(evidence).runId, 'run1')
  evidence = parseLogs([{ t: 140, line: "training.state accepted { state: 'training_tick', runId: 'run1' }" }], evidence)
  assert.equal(resolve(evidence).kind, 'training')
  assert.equal(resolve({ ...evidence, queueStatus: 'succeeded', queueUpdatedAt: 150 }).kind, 'training')
  assert.equal(resolve({ ...evidence, queueStatus: 'failed', queueUpdatedAt: 150 }).kind, 'failed')
  assert.equal(resolve({ ...evidence, queueStatus: 'queued', queueUpdatedAt: 160, queueStartedAt: 160 }).kind, 'queued')
  for (const raw of ['waiting_training', 'resetting']) {
    assert.equal(resolve({ ...evidence, trainingState: raw }).kind, raw)
  }
})
test('only state changes push; durations persist across repeat polls, failures and restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iota-activity-'))
  const path = join(dir, 'state.json'); const sent = []
  const send = async (before, after) => { sent.push([before, after]) }
  const current = resolve()
  try {
    await trackActivity(path, current, send)
    await trackActivity(path, { ...current, observedAt: 1030, queuePosition: 10, runId: 'different' }, send)
    await trackActivity(path, null, send)
    assert.equal(sent.length, 0)
    const confirmed = { ...current, kind: 'confirmed', observedAt: 1060 }
    await assert.rejects(trackActivity(path, confirmed, async () => { throw Error('offline') }))
    assert.equal(JSON.parse(await readFile(path, 'utf8')).startedAt, 1000)
    await trackActivity(path, confirmed, send)
    assert.equal(sent[0][1].durations.queued, 60)
    assert.equal(sent[0][1].startedAt, 1060)
    await trackActivity(path, { ...current, observedAt: 1090 }, send)
    await trackActivity(path, { ...confirmed, observedAt: 1120 }, send)
    assert.equal(sent[2][1].durations.queued, 90)
    assert.equal(sent[2][1].durations.confirmed, 30)
    await trackActivity(path, { ...confirmed, minerId: 'another', observedAt: 1150 }, send)
    assert.equal(sent.length, 3)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).durations, {})
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('durations use hours, minutes and seconds', () => {
  assert.equal(formatDuration(3661), '1:01:01')
  assert.equal(formatDuration(30), '0:00:30')
  assert.equal(formatDuration(6105), '1:41:45')
  assert.equal(formatDuration(0), '0:00:00')
  assert.equal(formatDuration(-1), '0:00:00')
  assert.equal(formatDuration(60), '0:01:00')
  assert.equal(formatDuration(3600), '1:00:00')
  assert.equal(formatDuration(90061.9), '25:01:01')
})


test('status reads current state timer without changing baseline or suppressing transitions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ma-timing-'))
  const path = join(dir, 'state.json')
  const current = resolve()
  try {
    assert.equal(await activityTiming(path, current), null)
    await trackActivity(path, current, async () => {})
    assert.deepEqual(await activityTiming(path, { ...current, observedAt: 1065 }), { startedAt: 1000, elapsedSeconds: 65 })
    assert.equal(await activityTiming(path, { ...current, kind: 'training' }), null)
    assert.equal(await activityTiming(path, { ...current, minerId: 'other' }), null)
    assert.equal(await activityTiming(path, { ...current, observedAt: 900 }), null)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).startedAt, 1000)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
