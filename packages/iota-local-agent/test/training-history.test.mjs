import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestTraining } from '../dist/training-history.js'

test('searches newest to oldest, persists source line and scans only appended complete lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'training-history-'))
  try {
    const logs = join(dir, 'logs'), checkpoint = join(dir, 'history.json')
    await mkdir(logs)
    await writeFile(join(logs, '2026-10-17-cli.log'), '[2026-10-17 08:00:00.000] queued\n')
    const older = join(logs, '2026-10-16-cli.log')
    await writeFile(older, '[2026-10-16 01:00:00.000] noise\n[2026-10-16 02:00:00.000] Starting FORWARD pass\n')
    let latest = await latestTraining(logs, checkpoint)
    assert.equal(latest.file, '2026-10-16-cli.log')
    assert.equal(latest.line, 2)
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'))
    assert.equal(saved.cursors['2026-10-16-cli.log'].line, 2)
    const today = join(logs, '2026-10-17-cli.log')
    await appendFile(today, "[2026-10-17 09:00:00.000] training.state accepted { state: 'training' }")
    assert.deepEqual(await latestTraining(logs, checkpoint), latest)
    await appendFile(today, '\n')
    latest = await latestTraining(logs, checkpoint)
    assert.equal(latest.file, '2026-10-17-cli.log')
    assert.equal(latest.line, 2)
    // A reset or removal of the source log must not erase historical training.
    await writeFile(today, '[2026-10-17 10:00:00.000] resetting\n')
    assert.deepEqual(await latestTraining(logs, checkpoint), latest)
    await rm(today)
    assert.deepEqual(await latestTraining(logs, checkpoint), latest)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('compares timestamps across main and cli logs rather than accepting the first file match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'training-history-'))
  try {
    await writeFile(join(dir, '2026-10-17-main.log'), '[2026-10-17 01:00:00.000] Starting FORWARD pass\n')
    await writeFile(join(dir, '2026-10-17-cli.log'), '[2026-10-17 02:00:00.000] after training forward pass\n')
    assert.equal((await latestTraining(dir, join(dir, 'state.json'))).file, '2026-10-17-cli.log')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
