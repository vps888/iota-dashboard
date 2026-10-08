import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOfficialPayload, upstreamKind, localReportInput } from '../dist/schema.js'
import { validMinerId } from './fixtures.mjs'

test('allows only known official endpoints and query shapes', () => {
  assert.equal(upstreamKind('/runs'), 'runs')
  assert.throws(() => upstreamKind('//attacker.example/path'))
  assert.throws(() => upstreamKind('/miners?run_id=x&other=y'))
})

test('rejects misaligned occupancy arrays', () => {
  assert.throws(() => parseOfficialPayload('/v1/runs_occupancy', {
    run_ids: ['run-a'], max_miners: [10], active_miners: [], slots_remaining: [10],
  }))
})


test('requires the expected throughput query parameters', () => {
  assert.equal(upstreamKind('/v1/epoch_miner_scores/runs/run-a/hotkeys/' + validMinerId + '/throughput?moving_average_window=3&period=week'), 'throughput')
  assert.throws(() => upstreamKind('/v1/epoch_miner_scores/runs/run-a/hotkeys/' + validMinerId + '/throughput?moving_average_window=4&period=week'))
})

test('accepts legacy local reports and optional privacy-limited NOID snapshots', () => {
  const base = {
    status: 'queued',
    description: 'queued',
    queuePosition: 2,
    controlConnected: true,
    restarts: 0,
    uptimeSec: 60,
    reportedAt: 1_800_000_000,
    os: 'macos',
    agentVersion: '0.2.0',
  }
  assert.equal(localReportInput.safeParse(base).success, true)
  const withNoid = {
    ...base,
    noid: {
      mode: 'training', running: true, cpuDuty: 10, gpuDuty: 10,
      cpuRate: 500_000, gpuRate: 800_000, accepted: 12, rejected: 0, stale: 1,
    },
  }
  assert.equal(localReportInput.safeParse(withNoid).success, true)
  assert.equal(localReportInput.safeParse({ ...withNoid, noid: { ...withNoid.noid, wallet: 'secret' } }).success, false)
})
