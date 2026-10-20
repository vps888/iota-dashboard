import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyEvidence, parseLogs, classify } from '../dist/guardian.js'
import { guardianAlerts, confirmedAlerts } from '../dist/guardian-alerts.js'

const now = 10000
const connected = { ok: true, connected: true, expectedHostPid: 123 }
function state(overrides = {}) {
  return { ...emptyEvidence(now - 3600), appPid: 123, minerAlive: true,
    controlConnected: true, status: 'waiting', description: '等待任务', ...overrides }
}

test('new session clears queue, fatal, exit and P2P evidence from previous run', () => {
  const previous = { ...state(), queueStatus: 'queued', queuePosition: 42,
    fatal: true, exitCode: 0, exitedAt: now - 100, p2pAnomalyAt: now - 100, p2pAnomalyDetected: true }
  const evidence = parseLogs([{ t: now, line: '[iota-cli runIotaCli] Connecting to CHANNEL' }], previous)
  assert.equal(evidence.queueStatus, null)
  assert.equal(evidence.fatal, false)
  assert.equal(evidence.exitCode, null)
  assert.equal(evidence.p2pAnomalyDetected, false)
})

test('rotation retains activity timestamp rather than inventing thirty minutes of silence', () => {
  const evidence = parseLogs([], { ...state(), lastActivityAt: now - 10 })
  assert.equal(evidence.lastActivityAt, now - 10)
})

test('silent logs with healthy control are unknown activity, not a confirmed fault', () => {
  const result = classify(emptyEvidence(now - 3600), 123, true, connected, now)
  assert.equal(result.status, 'waiting')
  assert.match(result.description, /无法仅凭日志确认/)
})

test('stopped app is reported directly and stale fatal/P2P flags cannot generate alarms', () => {
  const stopped = state({ appPid: null, minerAlive: false, fatal: true, p2pAnomalyDetected: true, p2pAnomalyAt: now })
  assert.match(classify(stopped, null, false, null, now).description, /主程序未运行/)
  assert.deepEqual(guardianAlerts(stopped, now), [])
})

test('health failure is not labeled P2P and only one alert is produced', () => {
  const alerts = guardianAlerts(state({ status: 'abnormal', description: '本地矿工控制服务不可访问', p2pAnomalyDetected: true, p2pAnomalyAt: now }), now)
  assert.equal(alerts.length, 1)
  assert.doesNotMatch(alerts[0].message, /P2P/)
})

test('P2P warnings expire and later training clears the warning', () => {
  const recent = state({ p2pAnomalyDetected: true, p2pAnomalyAt: now - 10 })
  assert.equal(guardianAlerts(recent, now).length, 1)
  assert.equal(guardianAlerts(recent, now + 301).length, 0)
  const recovered = parseLogs([{ t: now, line: 'after training forward pass' }], recent)
  assert.equal(recovered.p2pAnomalyDetected, false)
  assert.deepEqual(guardianAlerts({ ...recent, ...recovered }, now), [])
})

test('health probe requires consecutive observations and reason changes do not create new incidents', () => {
  const first = guardianAlerts(state({ status: 'abnormal', description: '控制服务不可访问' }), now)
  assert.deepEqual(confirmedAlerts(first, new Set()), [])
  const second = guardianAlerts(state({ status: 'abnormal', description: '控制连接断开' }), now + 30)
  assert.equal(confirmedAlerts(second, new Set(first.map(a => a.key))).length, 1)
  assert.equal(first[0].key, second[0].key)
})
