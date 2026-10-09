import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatNoidAtomicUnits,
  isValidNoidAddress,
  normalizeNoidPayments,
  normalizeNoidPoolSnapshot,
} from '../dist/noid.js'

const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const constant = 0x2bc830a3

function polymod(values) {
  let checksum = 1
  for (const value of values) {
    const top = checksum >>> 25
    checksum = (((checksum & 0x1ffffff) << 5) ^ value) >>> 0
    for (let index = 0; index < generators.length; index += 1) {
      if (((top >>> index) & 1) !== 0) checksum = (checksum ^ generators[index]) >>> 0
    }
  }
  return checksum >>> 0
}

function sampleAddress() {
  const payload = Array.from({ length: 32 }, (_, index) => (index * 7) % 32)
  const prefix = [3, 0, 15]
  const residue = (polymod([...prefix, ...payload, 0, 0, 0, 0, 0, 0]) ^ constant) >>> 0
  const checksum = [25, 20, 15, 10, 5, 0].map((shift) => (residue >>> shift) & 31)
  return `o1${[...payload, ...checksum].map((value) => alphabet[value]).join('')}`
}

test('validates the native NOID address prefix and checksum', () => {
  const address = sampleAddress()
  assert.equal(isValidNoidAddress(address), true)
  assert.equal(isValidNoidAddress(address.toUpperCase()), false)
  assert.equal(isValidNoidAddress(`x${address.slice(1)}`), false)
  assert.equal(isValidNoidAddress(`${address.slice(0, -1)}${address.endsWith('q') ? 'p' : 'q'}`), false)
})

test('normalizes only the requested Parano1d account snapshot', () => {
  const address = sampleAddress()
  const snapshot = normalizeNoidPoolSnapshot({
    coin: 'parano1d', address, found: true, hashrate: 1200, hashrate_unit: 'H/s', workersOnline: 1,
    workers: [{ worker: 'private-worker-label', hashrate: 1200, accepted: 4, rejected: 0, stale: 1, online: true, lastSeenAgo: 0 }],
    shares: { accepted10m: '4', accepted1h: '4', accepted24h: '4' },
    balance: { pending: '0', confirmed: '50000000', paid: '3000000' },
    payout: { minPayout: '50000000', remaining: '0' },
  }, address)
  assert.equal(snapshot.hashrateHps, 1200)
  assert.equal(snapshot.workersOnline, 1)
  assert.deepEqual(snapshot.balanceAtomic, { pending: '0', confirmed: '50000000', paid: '3000000' })
  assert.equal(snapshot.workers[0].accepted, 4)
  assert.equal('worker' in snapshot.workers[0], false)
  assert.throws(() => normalizeNoidPoolSnapshot({ coin: 'parano1d', address: 'different', found: true }, address), /identity mismatch/)
})

test('normalizes payout rows and formats six-decimal NOID units exactly', () => {
  const address = sampleAddress()
  const rows = normalizeNoidPayments({
    coin: 'parano1d', address, rows: [
      { amount: '50175610', txid: 'tx-1', status: 'confirmed', created_at: '2026-10-08T07:32:44.516Z' },
      { amount: 'bad', txid: 'tx-2', status: 'sent', created_at: 'invalid' },
    ],
  }, address)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].amountAtomic, '50175610')
  assert.equal(rows[0].status, 'confirmed')
  assert.equal(formatNoidAtomicUnits(rows[0].amountAtomic), '50.17561')
  assert.equal(formatNoidAtomicUnits('50000000'), '50')
  assert.equal(formatNoidAtomicUnits(null), '—')
})
