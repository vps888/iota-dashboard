import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordStateChange, recordEpochContributions } from '../dist/local-history.js'
const rows = async (dir, name) => (await readFile(join(dir, name), 'utf8')).trim().split('\n').map(JSON.parse)

test('state history is durable independently of delivery, idempotent on retries, and records durations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ma-history-'))
  try {
    const before = { minerId: 'miner', kind: 'queued', observedAt: 100, startedAt: 50 }
    const after = { ...before, kind: 'confirmed', observedAt: 200, durations: { queued: 150 }, runId: null, queuePosition: null, source: 'registration' }
    await recordStateChange(before, after, dir)
    await recordStateChange(before, { ...after, observedAt: 230 }, dir)
    const saved = await rows(dir, 'state-changes.jsonl')
    assert.equal(saved.length, 1)
    assert.equal(saved[0].previousDurationSeconds, 150)
    assert.equal(saved[0].from, 'queued')
    assert.equal(saved[0].to, 'confirmed')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('epochs persist raw numeric values, align throughput by epoch, dedupe and retain corrections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ma-epochs-'))
  const details = {
    metrics: { epochs: [188, 189], timestamps: [100, 200], token_counts: [60800, 0], act_contribution_percs: [0.0012, 0], activation_ranks: [100, 0], num_hotkeys_in_epochs: [113, 113], uploaded_partition_percs: [], weight_uploaded: [] },
    throughput: { epochs: [189, 188], throughputs: [12, 0] },
    tokens: { data_points: [{ timestamp: 90, token_count: 44800 }, { timestamp: 201, token_count: 999999 }] },
  }
  try {
    await Promise.all([recordEpochContributions('miner', 'run1', details, dir), recordEpochContributions('miner', 'run1', details, dir)])
    let saved = await rows(dir, 'epoch-contributions.jsonl')
    assert.equal(saved.length, 2)
    assert.equal(saved[0].trainingTokens, 60800)
    assert.equal(saved[0].contribution, 0.0012)
    assert.equal(saved[0].throughput, 0)
    assert.equal(saved[0].cumulativeTokens, 44800)
    assert.equal(saved[0].weightUploaded, null)
    details.metrics.token_counts[0] = 70000
    await recordEpochContributions('miner', 'run1', details, dir)
    saved = await rows(dir, 'epoch-contributions.jsonl')
    assert.equal(saved.length, 3)
    assert.equal(saved[2].trainingTokens, 70000)
    await recordEpochContributions('miner', 'run2', details, dir)
    assert.equal((await rows(dir, 'epoch-contributions.jsonl')).length, 5)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
