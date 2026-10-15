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


test('restart flow uses staged IOTA and main_pool shutdown, and commands are acknowledged and deduplicated', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/feishu.ts'), 'utf8')
  assert.match(source, /terminateIotaAppNow\(\)[\s\S]*setTimeout\(resolve, 3000\)[\s\S]*killIotaWorkersNow\(\)[\s\S]*setTimeout\(resolve, 5000\)[\s\S]*startOptimized\(\)/)
  assert.match(source, /await markAcknowledged\(messageId\)[\s\S]*const result = command === 'status'/)
  assert.doesNotMatch(source, /已收到「\$\{text\}」/)
  assert.doesNotMatch(source, /正在处理…/)
  assert.match(source, /const key = `\$\{botConfig\.chatId\}:\$\{sender\}:\$\{command\}`[\s\S]*if \(handled\.has\(key\) \\|\\| inFlight\.has\(key\)\) return/)
  assert.match(source, /handled\.set\(key, now \+ 60_000\)/)
  assert.match(source, /inFlight\.add\(key\)[\s\S]*inFlight\.delete\(key\)/)
})

test('polling process monitor compares PID and command identities and sends a Feishu alert for ended workers', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/feishu.ts'), 'utf8')
  assert.match(source, /setTimeout\(resolve, 30_000\)/)
  assert.match(source, /previous\.workers\.filter\(\(old\) => !current\.workers\.some\(\(now\) => now\.pid === old\.pid && now\.command === old\.command\)\)/)
  assert.match(source, /previous\.appPid !== null && current\.appPid === null/)
  assert.match(source, /IOTA 进程状态变化/)
  assert.match(source, /await sendText\(client, config\.chatId, `IOTA 进程状态变化/)
})

test('process monitor detects individual main_pool exits even when IOTA app remains alive', async () => {
  const { endedIotaProcesses } = await import('../dist/feishu.js')
  const previous = { appPid: 100, workers: [{ pid: 200, command: 'main_pool --worker' }, { pid: 201, command: 'main_pool --worker' }] }
  const current = { appPid: 100, workers: [{ pid: 201, command: 'main_pool --worker' }] }
  const changes = endedIotaProcesses(previous, current)
  assert.equal(changes.appEnded, false)
  assert.equal(changes.appReplaced, false)
  assert.deepEqual(changes.endedWorkers.map((worker) => worker.pid), [200])
})

test('process monitor detects app exit and replacement independently', async () => {
  const { endedIotaProcesses } = await import('../dist/feishu.js')
  const workers = []
  assert.equal(endedIotaProcesses({ appPid: 123, workers }, { appPid: null, workers }).appEnded, true)
  assert.equal(endedIotaProcesses({ appPid: 123, workers }, { appPid: 456, workers }).appReplaced, true)
  assert.equal(endedIotaProcesses({ appPid: null, workers }, { appPid: 456, workers }).appReplaced, false)
})


test('network capacity headings include English tiers and each row shows model plus run ID', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/feishu.ts'), 'utf8')
  assert.match(source, /\['金级', 'Gold'/)
  assert.match(source, /\['银级', 'Silver'/)
  assert.match(source, /\['铜级', 'Bronze'/)
  assert.match(source, /`\$\{modelPrefix\} - \$\{run\.runId\}：/)
})
