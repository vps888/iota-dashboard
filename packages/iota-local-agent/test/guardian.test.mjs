import test from 'node:test'
import assert from 'node:assert/strict'
import { selectOrphanedIotaWorkers } from '../dist/guardian.js'

const app = '/Applications/IOTA Train at Home.app/Contents/MacOS/IOTA Train at Home'
const worker = '/Applications/IOTA Train at Home.app/Contents/Frameworks/iota-cli/main_pool'

function rows(entries) {
  return new Map(entries.map(([pid, ppid, command]) => [pid, { pid, ppid, command }]))
}

test('selects all IOTA main_pool workers regardless of parent when the app is stopped', () => {
  const found = selectOrphanedIotaWorkers(rows([
    [100, 1, `${worker} --worker`],
    [101, 100, `${worker} --worker`],
    [102, 1, 'unrelated_process'],
  ]), app, worker)
  assert.deepEqual([...found.keys()], [100, 101])
})

test('does not select workers while the official app is running', () => {
  const found = selectOrphanedIotaWorkers(rows([
    [100, 1, `${worker} --worker`],
    [200, 1, app],
  ]), app, worker)
  assert.equal(found.size, 0)
})
