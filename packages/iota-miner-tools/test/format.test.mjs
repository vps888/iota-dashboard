import test from 'node:test'
import assert from 'node:assert/strict'
import { formatOfficialLookup } from '../dist/format.js'
import { validMinerId } from './fixtures.mjs'

const lookup = {
  status: 'unknown', miner: null, runId: null, checkedAt: 1_800_000_000_000,
  lastSuccessfulFetchAt: null, coverage: { successful: 2, total: 3 }, stale: false,
  warning: '部分名单失败',
}

test('formats unknown CLI results with coverage and reason', () => {
  const output = formatOfficialLookup(validMinerId, lookup)
  assert.match(output, /状态: 状态待确认/)
  assert.match(output, /名单覆盖: 2\/3/)
  assert.match(output, /部分名单失败/)
})
