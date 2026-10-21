import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyEvidence, parseLogs } from '../dist/guardian.js'

const now = Date.parse('2026-10-10T12:00:00Z') / 1000

test('detects adjacent-layer P2P peer anomaly without initiating a restart', () => {
  const evidence = parseLogs([
    { t: now - 2, line: '[2026-10-10 12:00:00.000] DEBUG No p2p_node_ids found on any adjacent-layer peer (layer=0)' },
  ], { sessionStartedAt: now - 60 })
  assert.equal(evidence.p2pAnomalyDetected, true)
})

test('recognizes no-routable-peer variants but does not trust a legacy latched boolean', () => {
  const prior = { ...emptyEvidence(now - 60), p2pAnomalyDetected: true }
  const evidence = parseLogs([], prior)
  assert.equal(evidence.p2pAnomalyDetected, false)
  const detected = parseLogs([
    { t: now - 2, line: '[2026-10-10 12:00:00.000] WARNING No routable peers for layer-1' },
  ], { sessionStartedAt: now - 60 })
  assert.equal(detected.p2pAnomalyDetected, true)
})



test('daily log rotation without a fresh connect record does not reset session or queue evidence', () => {
  const started = Date.parse('2026-10-15T10:00:00Z') / 1000
  const prior = {
    ...emptyEvidence(started),
    queueStatus: 'queued',
    queuePosition: 1110,
    queueUpdatedAt: started + 60,
    trainingState: 'resetting',
  }
  const latest = parseLogs([
    { t: started + 120, line: "[2026-10-15 18:02:00.000] DEBUG Successfully completed request to /miner/register/status/queue-id; response: {'status': 'queued', 'position': 1060}" },
  ], prior)
  assert.equal(latest.sessionStartedAt, started)
  assert.equal(latest.queuePosition, 1060)
  assert.equal(latest.queueUpdatedAt, started + 120)
})
