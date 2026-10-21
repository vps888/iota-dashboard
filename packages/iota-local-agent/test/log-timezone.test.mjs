import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Isolate TZ per process, independent of the developer/CI host timezone.
function runInZone(tz, source) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  }))
}
const guardian = new URL('../dist/guardian.js', import.meta.url).href
for (const [zone, wall, iso] of [
  ['America/New_York', '2026-10-20 22:10:56.771', '2026-10-21T02:10:56.771Z'],
  ['America/New_York', '2026-01-20 22:10:56.771', '2026-01-21T03:10:56.771Z'],
  ['America/Phoenix', '2026-10-20 19:10:56.771', '2026-10-21T02:10:56.771Z'],
  ['Asia/Shanghai', '2026-10-21 10:10:56.771', '2026-10-21T02:10:56.771Z'],
  ['UTC', '2026-10-21 02:10:56.771', '2026-10-21T02:10:56.771Z'],
]) {
  test(`log wall clock uses host timezone and date-specific DST: ${zone} ${wall}`, () => {
    const actual = runInZone(zone, `
      import { parseLocalLogTimestamp } from ${JSON.stringify(guardian)};
      console.log(JSON.stringify(parseLocalLogTimestamp(${JSON.stringify(wall)}, ${JSON.stringify(zone)})));
    `)
    assert.equal(actual, Date.parse(iso) / 1000)
  })
}

test('live EDT forward pass supersedes legacy stale P2P state and is classified as training', () => {
  const result = runInZone('America/New_York', `
    import { parseLocalLogTimestamp, parseLogs, classify, emptyEvidence } from ${JSON.stringify(guardian)};
    const now = Date.parse('2026-10-21T02:11:16Z') / 1000;
    const evidence = parseLogs([
      { t: parseLocalLogTimestamp('2026-10-20 22:10:56.769', 'America/New_York'), line: 'Starting FORWARD pass' },
      { t: parseLocalLogTimestamp('2026-10-20 22:10:56.771', 'America/New_York'), line: 'after training forward pass' },
    ], { ...emptyEvidence(now - 86400), queueStatus: 'succeeded', p2pAnomalyDetected: true });
    console.log(JSON.stringify({ evidence, result: classify(evidence, 123, true,
      { ok: true, connected: true, expectedHostPid: 123 }, now) }));
  `)
  assert.equal(result.result.status, 'training')
  assert.equal(result.evidence.p2pAnomalyDetected, false)
  assert.equal(result.evidence.trainingAt, Date.parse('2026-10-21T02:10:56.771Z') / 1000)
})

test('newest UTC-named log is read completely even when local calendar date differs', () => {
  const result = runInZone('America/New_York', `
    import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const home = await mkdtemp(join(tmpdir(), 'miner-log-test-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { logRecords } = await import(${JSON.stringify(guardian)});
      const dir = join(home, 'Library', 'Logs', 'IOTA Train at Home');
      await mkdir(dir, { recursive: true });
      // Neither filename matches today's date; the live file exceeds the tail limit.
      await writeFile(join(dir, '2026-10-21-cli.log'),
        "[2026-10-20 22:07:49.789] Successfully completed request to /miner/register/status/q; response: {'status': 'succeeded'}\\n"
        + 'padding\\n'.repeat(80000));
      const records = await logRecords();
      console.log(JSON.stringify(records.map(r => r.line)));
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  `)
  assert.equal(result.length, 1)
  assert.match(result[0], /succeeded/)
})

test('invalid timestamps are rejected rather than normalized into another date', () => {
  const result = runInZone('America/New_York', `
    import { parseLocalLogTimestamp } from ${JSON.stringify(guardian)};
    console.log(JSON.stringify(['not a timestamp', '2026-02-30 12:00:00.000',
      '2026-10-20 25:00:00.000'].map(s => Number.isNaN(parseLocalLogTimestamp(s)))));
  `)
  assert.deepEqual(result, [true, true, true])
})

test('default parser uses OS timezone even when parent injects a different TZ', () => {
  const result = runInZone('Pacific/Honolulu', `
    import { hostTimeZone, parseLocalLogTimestamp } from ${JSON.stringify(guardian)};
    import { readlinkSync } from 'node:fs';
    const zone = hostTimeZone();
    console.log(JSON.stringify({zone, expectedZone: readlinkSync('/etc/localtime').split('/zoneinfo/')[1],
      actual: parseLocalLogTimestamp('2026-10-21 13:00:00.000'),
      explicit: parseLocalLogTimestamp('2026-10-21 13:00:00.000', zone)}));
  `)
  assert.equal(result.zone, result.expectedZone)
  assert.equal(result.actual, result.explicit)
})
