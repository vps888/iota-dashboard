import { appendFile, mkdir, readFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { AGENT_DIR } from './paths.js'
import type { ActivitySnapshot } from './activity-monitor.js'
import type { createOfficialClient } from './official.js'

type Details = Awaited<ReturnType<ReturnType<typeof createOfficialClient>['queryDashboardDetails']>>
export const HISTORY_DIR = join(AGENT_DIR, 'history')
// Serialized append + replayed IDs make retries and process restarts idempotent.
let pending: Promise<unknown> = Promise.resolve()
export function appendHistory(path: string, records: Array<{ id: string; [key: string]: unknown }>): Promise<void> {
  const task = pending.then(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    let text = ''
    try { text = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const ids = new Set<string>()
    for (const line of text.split('\n')) {
      try { ids.add(JSON.parse(line).id) } catch { /* A damaged row must not hide later records. */ }
    }
    const fresh = records.filter((record) => {
      if (ids.has(record.id)) return false
      ids.add(record.id); return true
    })
    if (!fresh.length) return
    const prefix = text && !text.endsWith('\n') ? '\n' : ''
    await appendFile(path, prefix + fresh.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 })
    await chmod(path, 0o600)
  })
  pending = task.catch(() => {})
  return task
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function recordStateChange(before: ActivitySnapshot, after: ActivitySnapshot, dir = HISTORY_DIR): Promise<void> {
  const startedAt = before.startedAt === null ? null : before.startedAt ?? before.observedAt
  await appendHistory(join(dir, 'state-changes.jsonl'), [{
    id: hash([after.minerId, startedAt, before.kind, after.kind]),
    type: 'state_change', recordedAt: new Date(after.observedAt * 1000).toISOString(),
    minerId: after.minerId, from: before.kind, to: after.kind,
    previousStartedAt: startedAt, changedAt: after.observedAt,
    previousDurationSeconds: startedAt === null ? null : Math.max(0, after.observedAt - startedAt),
    durations: after.durations ?? {}, runId: after.runId, queuePosition: after.queuePosition,
    source: after.source,
  }])
}
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
export async function recordEpochContributions(minerId: string, runId: string, details: Details, dir = HISTORY_DIR, now = Date.now()): Promise<void> {
  const throughput = new Map(details.throughput.epochs.map((epoch, i) => [epoch, details.throughput.throughputs[i]]))
  const points = [...details.tokens.data_points].sort((a, b) => a.timestamp - b.timestamp)
  const records = details.metrics.epochs.map((epoch, i) => {
    const timestamp = numeric(details.metrics.timestamps[i])
    const data = {
      minerId, runId, epoch, sampleAt: timestamp,
      trainingTokens: numeric(details.metrics.token_counts[i]),
      contribution: numeric(details.metrics.act_contribution_percs[i]),
      activationRank: numeric(details.metrics.activation_ranks[i]),
      totalMiners: numeric(details.metrics.num_hotkeys_in_epochs[i]),
      throughput: numeric(throughput.get(epoch)),
      cumulativeTokens: timestamp == null ? null : numeric(points.filter((p) => p.timestamp <= timestamp).at(-1)?.token_count),
      uploadedPartitionPercent: numeric(details.metrics.uploaded_partition_percs[i]),
      weightUploaded: numeric(details.metrics.weight_uploaded[i]),
    }
    return { id: hash(data), type: 'epoch_contribution', recordedAt: new Date(now).toISOString(), ...data }
  })
  await appendHistory(join(dir, 'epoch-contributions.jsonl'), records)
}
