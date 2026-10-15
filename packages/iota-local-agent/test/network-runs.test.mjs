import test from 'node:test'
import assert from 'node:assert/strict'
import { sortNetworkRuns, tierFromDescription } from '../dist/official.js'

test('classifies run tier from official description', () => {
  assert.equal(tierFromDescription('Tier 0 (Bronze)'), 'bronze')
  assert.equal(tierFromDescription('Silver tier run'), 'silver')
  assert.equal(tierFromDescription('Gold - Tier 3'), 'gold')
  assert.equal(tierFromDescription('unknown tier'), 'other')
})

test('sorts network runs gold then silver then bronze, then stable run ID', () => {
  const runs = [
    { tier: 'bronze', runId: 'b' },
    { tier: 'gold', runId: 'z' },
    { tier: 'silver', runId: 's' },
    { tier: 'gold', runId: 'a' },
    { tier: 'other', runId: 'o' },
  ]
  assert.deepEqual(sortNetworkRuns(runs).map((run) => run.runId), ['a', 'z', 's', 'b', 'o'])
})

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'

test('status formatter uses explicit Shanghai date and seconds fields', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/feishu.ts'), 'utf8')
  assert.match(source, /timeZone: 'Asia\/Shanghai'/)
  assert.match(source, /formatToParts\(new Date\(millis\)\)/)
  assert.match(source, /part\('month'\).*part\('day'\).*part\('second'\)/)
})


test('Feishu status output includes requested compact labels and blank separators', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/feishu.ts'), 'utf8')
  for (const expected of ['状态：排队中', '应用进程：', '训练记录：', '轮次\\t时间\\t状态\\t排名', '--------------------------------------------------', '全网任务容量：', '更新时间：']) {
    assert.ok(source.includes(expected), `missing ${expected}`)
  }
  assert.match(source, /dateMinute\(record\.ts\).*relativeAge\(record\.ts\).*upload.*rank/s)
})
