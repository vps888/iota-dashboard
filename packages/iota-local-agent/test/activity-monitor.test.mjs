import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
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
  const current = { ...resolve(), startedAt: 1000 }
  try {
    await trackActivity(path, current, send)
    await trackActivity(path, { ...current, observedAt: 1030, queuePosition: 10, runId: 'different' }, send)
    await trackActivity(path, null, send)
    assert.equal(sent.length, 0)
    const confirmed = { ...current, kind: 'confirmed', observedAt: 1060, startedAt: 1060 }
    await assert.rejects(trackActivity(path, confirmed, async () => { throw Error('offline') }))
    assert.equal(JSON.parse(await readFile(path, 'utf8')).startedAt, 1000)
    await trackActivity(path, confirmed, send)
    assert.equal(sent[0][1].durations.queued, 60)
    assert.equal(sent[0][1].startedAt, 1060)
    await trackActivity(path, { ...current, observedAt: 1090, startedAt: 1090 }, send)
    await trackActivity(path, { ...confirmed, observedAt: 1120, startedAt: 1120 }, send)
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
  const current = { ...resolve(), startedAt: 1000 }
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

const activeOfficial = {
  stale: false, coverage: { successful: 8, total: 8 },
  miner: { hotkey: 'miner', runId: 'official-run', isActive: true, sampleAt: 990 },
}
test('fresh official active roster overrides queued registration, without requiring throughput', () => {
  const evidence = { ...base, trainingState: 'training_tick', trainingUpdatedAt: 140, trainingRunId: 'old-run', queueUpdatedAt: 980, queueStartedAt: 980 }
  const current = resolveActivity('miner', evidence, true, 1000, activeOfficial)
  assert.equal(current.kind, 'training')
  assert.equal(current.runId, 'official-run')
  assert.equal(current.queuePosition, null)
  assert.match(current.source, /is_active=true/)
  assert.equal(resolveActivity('miner', evidence, false, 1000, activeOfficial).kind, 'stopped')
})
test('official roster does not erase a newer explicit phase or reset', () => {
  for (const [trainingState, trainingPhase, kind] of [
    ['layer_state_change', 'WEIGHTS_UPLOADING', 'weights_uploading'],
    ['resetting', null, 'resetting'], ['waiting_training', null, 'waiting_training'],
  ]) {
    const evidence = { ...base, trainingState, trainingPhase, trainingUpdatedAt: 999 }
    assert.equal(resolveActivity('miner', evidence, true, 1000, activeOfficial).kind, kind)
  }
})
test('newer queued logs override old training regardless of unreliable official lookups', () => {
  const evidence = { ...base, trainingState: 'training_tick', trainingUpdatedAt: 940, queueUpdatedAt: 995 }
  for (const official of [null, { ...activeOfficial, stale: true },
    { ...activeOfficial, coverage: { successful: 7, total: 8 } },
    { ...activeOfficial, miner: null },
    ...[null, 699, 1001].map(sampleAt => ({ ...activeOfficial, miner: { ...activeOfficial.miner, sampleAt } })),
    { ...activeOfficial, miner: { ...activeOfficial.miner, hotkey: 'other' } },
  ]) assert.equal(resolveActivity('miner', evidence, true, 1000, official).kind, 'queued')
  const inactive = { ...activeOfficial, miner: { ...activeOfficial.miner, isActive: false } }
  assert.equal(resolveActivity('miner', evidence, true, 1000, inactive).kind, 'queued')
})
test('official outage still permits newer local training evidence and initial queuing', () => {
  assert.equal(resolveActivity('miner', { ...base, trainingState: 'training_tick', trainingUpdatedAt: 999 }, true, 1000, null).kind, 'training')
  assert.equal(resolveActivity('miner', base, true, 1000, null).kind, 'queued')
})

const tick = (t, run = 'run1') => ({ t, line: `training.state accepted { state: 'training_tick', runId: '${run}' }` })
const reset = t => ({ t, line: "training.state accepted { state: 'resetting', runId: 'run1' }" })
const training = { minerId: 'miner', kind: 'training', runId: 'run1', observedAt: 1000, source: 'official', queuePosition: null }
test('timing prefers valid agent snapshot, then recognizable own history, then app logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ma-replay-'))
  const path = join(dir, 'activity.json')
  const records = [tick(100), tick(200), tick(900)]
  try {
    assert.deepEqual(await activityTiming(path, training, records), { startedAt: 100, elapsedSeconds: 900 })
    await mkdir(join(dir, 'history'))
    await writeFile(join(dir, 'history', 'state-changes.jsonl'), 'broken\n' + JSON.stringify({ type: 'state_change', minerId: 'miner', to: 'training', changedAt: 300, runId: 'run1' }) + '\n')
    assert.equal((await activityTiming(path, training, records)).startedAt, 300)
    await writeFile(path, JSON.stringify({ ...training, startedAt: 400 }))
    assert.equal((await activityTiming(path, training, records)).startedAt, 400)
    await writeFile(path, '{broken')
    assert.equal((await activityTiming(path, training, records)).startedAt, 300)
    assert.equal(await readFile(path, 'utf8'), '{broken')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('app replay respects continuous phases, run changes, restarts and missing evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ma-replay-'))
  const path = join(dir, 'activity.json')
  const timing = records => activityTiming(path, training, records)
  try {
    assert.equal((await timing([tick(100), reset(300), tick(500), tick(900)])).startedAt, 500)
    assert.equal((await timing([tick(100, 'old'), tick(400), tick(900)])).startedAt, 400)
    assert.equal((await timing([tick(100), { t: 400, line: '[iota-cli runIotaCli] Connecting to CHANNEL' }, tick(600)])).startedAt, 600)
    assert.equal(await timing([tick(100), { t: 400, line: '[iota-cli runIotaCli] Connecting to CHANNEL' }]), null)
    assert.equal(await timing([]), null)
    assert.equal(await timing([{ t: 100, line: 'unrecognized log' }]), null)
    assert.equal(await timing([tick(1001)]), null)
    assert.equal(await timing([tick(100), reset(900)]), null)
    const queued = { t: 800, line: 'Successfully completed request to /miner/register response: {"status":"queued","position":685}' }
    assert.equal((await timing([tick(100), queued, tick(900)])).startedAt, 900)
    assert.equal(await timing([tick(100), queued]), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('background keeps unknown start unknown, recovers log start without consuming transitions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ma-unknown-'))
  const path = join(dir, 'activity.json')
  try {
    await trackActivity(path, training, async () => {})
    assert.equal(JSON.parse(await readFile(path, 'utf8')).startedAt, null)
    assert.equal(await activityTiming(path, training), null)
    const recovered = await activityTiming(path, training, [tick(100), tick(900)])
    await trackActivity(path, { ...training, startedAt: recovered.startedAt }, async () => {})
    assert.equal((await activityTiming(path, training)).startedAt, 100)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('new queue logs supersede training ticks during official outage', () => {
  for (const queueStartedAt of [110, 995]) {
    const evidence = { ...base, queueStartedAt, queueUpdatedAt: 995, trainingState: 'training_tick', trainingUpdatedAt: 940, trainingRunId: 'run1' }
    const current = resolveActivity('miner', evidence, true, 1000, null)
    assert.equal(current.kind, 'queued')
    assert.equal(current.runId, null)
    assert.equal(current.queuePosition, 535)
  }
  const resetEvidence = { ...base, queueUpdatedAt: 995, trainingState: 'resetting', trainingUpdatedAt: 990 }
  assert.notEqual(resolveActivity('miner', resetEvidence, true, 1000, null)?.kind, 'training')
})
test('native worker forward pass logs identify training and recover the continuous start', async () => {
  const records = [{ t: 500, line: 'Starting FORWARD pass' }, { t: 900, line: 'after training forward pass' }]
  const evidence = parseLogs(records, {})
  const current = resolveActivity('miner', evidence, true, 1000, null)
  assert.equal(current.kind, 'training')
  const dir = await mkdtemp(join(tmpdir(), 'ma-forward-'))
  try {
    assert.equal((await activityTiming(join(dir, 'activity.json'), current, records)).startedAt, 500)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('legacy trainingState without a timestamp must not fabricate a training state', () => {
  const evidence = { ...base, trainingState: 'training_tick', trainingUpdatedAt: null, trainingAt: 100 }
  assert.equal(resolveActivity('miner', evidence, true, 1000, null).kind, 'queued')
})


test('queue and training use event order without an age threshold', () => {
  const evidence = { ...base, queueStartedAt: 110, queueUpdatedAt: 995,
    trainingState: 'training_tick', trainingUpdatedAt: 140, trainingAt: 140, trainingRunId: 'run1' }
  for (const official of [null, { ...activeOfficial, stale: true },
    { ...activeOfficial, coverage: { successful: 7, total: 8 } }, { ...activeOfficial, miner: null }]) {
    const current = resolveActivity('miner', evidence, true, 1000, official)
    assert.equal(current.kind, 'queued')
    assert.equal(current.queuePosition, 535)
    assert.equal(current.runId, null)
  }
  for (const at of [700, 701, 1001]) {
    assert.equal(resolveActivity('miner', { ...evidence, trainingUpdatedAt: 140, trainingAt: at }, true, 1000, null).kind,
      'queued')
  }
  assert.equal(resolveActivity('miner', { ...evidence, trainingAt: 999 }, true, 1000, null).kind, 'training')
  assert.equal(resolveActivity('miner', evidence, true, 1000, activeOfficial).kind, 'queued')
  assert.equal(resolveActivity('miner', evidence, true, 1000, { ...activeOfficial, miner: { ...activeOfficial.miner, sampleAt: 999 } }).kind, 'training')
})

test('local event order has no timeout and queued timing starts at the transition', async () => {
  const evidence = { ...base, trainingState: 'training_tick', trainingUpdatedAt: 140, trainingAt: 140 }
  assert.equal(resolveActivity('miner', evidence, true, 100000, null).kind, 'training')
  assert.equal(resolveActivity('miner', { ...evidence, queueUpdatedAt: 141 }, true, 142, null).kind, 'queued')
  const records = [tick(100), { t: 200, line: 'Successfully completed request to /miner/register response: {"status":"queued","position":42}' },
    { t: 300, line: 'Successfully completed request to /miner/register response: {"status":"queued","position":40}' }]
  const dir = await mkdtemp(join(tmpdir(), 'ma-queue-order-'))
  try {
    const current = resolveActivity('miner', parseLogs(records, {}), true, 400, null)
    assert.equal(current.kind, 'queued')
    assert.equal(current.queuePosition, 40)
    assert.equal((await activityTiming(join(dir, 'state.json'), current, records)).startedAt, 200)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
