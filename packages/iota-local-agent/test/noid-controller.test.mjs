import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { reconcileNoid, requestNoid, targetForIotaStatus } from '../dist/noid-controller.js'
import { classify, emptyEvidence } from '../dist/guardian.js'

test('IOTA training uses reduced NOID duty; other states use default duty', () => {
  assert.deepEqual(targetForIotaStatus('training'), { mode: 'training', cpuDuty: 10, gpuDuty: 10 })
  for (const status of ['paused', 'starting', 'queued', 'waiting', 'abnormal', undefined]) {
    assert.deepEqual(targetForIotaStatus(status), { mode: 'default', cpuDuty: 100, gpuDuty: 70 })
  }
})

test('fresh training evidence takes precedence over an old queued status', () => {
  const now = 2_000_000
  const evidence = emptyEvidence(now - 120)
  evidence.queueStatus = 'queued'
  evidence.queuePosition = 1
  evidence.queueUpdatedAt = now - 10
  evidence.trainingAt = now - 15
  evidence.lastActivityAt = now - 15
  const result = classify(evidence, 12, true, { ok: true, connected: true, expectedHostPid: 12 }, now)
  assert.equal(result.status, 'training')
})

test('expired training evidence returns to the queued state', () => {
  const now = 2_000_000
  const evidence = emptyEvidence(now - 600)
  evidence.queueStatus = 'queued'
  evidence.queuePosition = 1
  evidence.queueUpdatedAt = now - 10
  evidence.trainingAt = now - 301
  const result = classify(evidence, 12, true, { ok: true, connected: true, expectedHostPid: 12 }, now)
  assert.equal(result.status, 'queued')
})

test('local control client exchanges a bounded newline-delimited JSON request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iota-noid-control-'))
  const socketPath = join(directory, 'control.sock')
  const server = createServer((socket) => {
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8')
      const newline = input.indexOf('\n')
      if (newline < 0) return
      assert.deepEqual(JSON.parse(input.slice(0, newline)), { command: 'status' })
      socket.end(`${JSON.stringify({ ok: true, running: true, cpuDuty: 100, gpuDuty: 70 })}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  try {
    assert.deepEqual(await requestNoid(socketPath, { command: 'status' }), {
      ok: true, running: true, cpuDuty: 100, gpuDuty: 70,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('does not start a second miner when an unmanaged NOID process is detected', async () => {
  const rows = new Map([[22, {
    pid: 22,
    ppid: 1,
    command: '/Applications/NOID Miner.app/Contents/MacOS/NOIDMiner',
  }]])
  const state = await reconcileNoid('queued', { dashboardUrl: '', token: '', minerId: '', reportEnabled: false }, rows, join(tmpdir(), 'missing-noid-control.sock'))
  assert.equal(state.mode, 'unmanaged')
  assert.equal(state.running, true)
  assert.match(state.error ?? '', /避免双挖/)
})

test('refuses non-success control responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iota-noid-control-'))
  const socketPath = join(directory, 'control.sock')
  const server = createServer((socket) => socket.once('data', () => socket.end('{"ok":false,"error":"unsupported command"}\n')))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  try {
    await assert.rejects(requestNoid(socketPath, { command: 'bad' }), /unsupported command/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
