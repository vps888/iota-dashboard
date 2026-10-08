import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

test('rejects invalid Miner IDs before making network requests', () => {
  const result = spawnSync(process.execPath, [cliPath, 'invalid-id'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Miner ID/)
  assert.equal(result.stdout, '')
})

test('shows CLI usage when no Miner ID is supplied', () => {
  const result = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /用法/)
})
