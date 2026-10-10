import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyEvidence, parseLogs } from '../dist/guardian.js'

const now = Date.parse('2026-10-10T12:00:00Z') / 1000

test('recommends a clean restart when adjacent-layer P2P peers are missing', () => {
  const evidence = parseLogs([
    { t: now - 2, line: '[2026-10-10 12:00:00.000] DEBUG No p2p_node_ids found on any adjacent-layer peer (layer=0)' },
  ], { sessionStartedAt: now - 60 })
  assert.equal(evidence.p2pRestartRecommended, true)
})

test('recognizes no-routable-peer variants and retains the warning within the session', () => {
  const prior = { ...emptyEvidence(now - 60), p2pRestartRecommended: true }
  const evidence = parseLogs([], prior)
  assert.equal(evidence.p2pRestartRecommended, true)
  const detected = parseLogs([
    { t: now - 2, line: '[2026-10-10 12:00:00.000] WARNING No routable peers for layer-1' },
  ], { sessionStartedAt: now - 60 })
  assert.equal(detected.p2pRestartRecommended, true)
})
