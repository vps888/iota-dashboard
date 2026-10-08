import test from 'node:test'
import assert from 'node:assert/strict'
import { validateMinerId } from '../dist/ss58.js'
import { validMinerId } from './fixtures.mjs'


test('validates a network-42 SS58 Miner ID checksum', () => {
  assert.deepEqual(validateMinerId(validMinerId), { valid: true })
  assert.equal(validateMinerId(`${validMinerId.slice(0, -1)}1`).valid, false)
})

test('rejects malformed Miner IDs', () => {
  assert.deepEqual(validateMinerId(''), { valid: false, reason: 'empty' })
  assert.equal(validateMinerId('0'.repeat(48)).valid, false)
})
