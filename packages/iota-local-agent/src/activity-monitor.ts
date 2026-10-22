import { readFile, writeFile } from 'node:fs/promises'
import { parseLogs, type Evidence, type LogRecord } from './guardian.js'
import { join, dirname } from 'node:path'

// Unknown future registration/state values are retained, not silently discarded.
export type ActivityKind = string
export interface ActivitySnapshot {
  minerId: string
  kind: ActivityKind
  runId: string | null
  observedAt: number
  source: string
  queuePosition: number | null
  startedAt?: number | null
  durations?: Record<string, number>
}
export const ACTIVITY_LABELS: Record<string, string> = {
  stopped: '未运行', queued: '排队中', confirming: '确认中', confirmed: '已确认',
  processing: '注册处理中', succeeded: '注册成功，等待训练状态', failed: '注册失败',
  waiting_training: '等待训练任务', resetting: '重置中', training: '训练中',
  weights_uploading: '权重上传中', merging_partitions: '分区合并中',
}
export function activityLabel(kind: string): string { return ACTIVITY_LABELS[kind] ?? kind }

export interface OfficialActivityEvidence {
  stale: boolean
  coverage: { successful: number; total: number }
  miner: { hotkey: string; runId: string; isActive: boolean; sampleAt: number | null } | null
}

export function resolveActivity(minerId: string, evidence: Evidence, appRunning: boolean, now: number, official?: OfficialActivityEvidence | null): ActivitySnapshot | null {
  const snapshot = (kind: string, source: string): ActivitySnapshot => ({
    minerId, kind, runId: evidence.trainingRunId ?? null, observedAt: now, source,
    queuePosition: kind === 'queued' ? evidence.queuePosition : null,
  })
  if (!appRunning) return snapshot('stopped', '本机进程快照：IOTA 主程序未运行')
  const registrationAt = evidence.queueUpdatedAt ?? 0
  const trainingAt = evidence.trainingUpdatedAt ?? 0
  const sample = official?.miner
  const officialCurrent = official != null && !official.stale
    && official.coverage.total > 0 && official.coverage.successful === official.coverage.total
    && sample?.hotkey === minerId && sample.sampleAt != null
    && Number.isFinite(sample.sampleAt) && sample.sampleAt <= now && now - sample.sampleAt <= 300
  // An explicit newer queue response supersedes historical training, even when
  // the official lookup is unavailable. Only a newer active roster can override it.
  const latestTrainingAt = Math.max(trainingAt, evidence.trainingAt ?? 0)
  if (evidence.queueStatus === 'queued' && registrationAt > 0 && registrationAt <= now
    && registrationAt > latestTrainingAt
    && !(officialCurrent && sample?.isActive && sample.sampleAt! > registrationAt)) {
    return { ...snapshot('queued', '注册接口 status=queued'), runId: null }
  }
  // The registration queue is not the training roster. A fresh active roster
  // entry wins over registration polls, but not a newer explicit training phase.
  if (officialCurrent && sample?.isActive) {
    const explicitPhase = evidence.trainingState && evidence.trainingState !== 'training_tick'
      && evidence.trainingState !== 'training' && trainingAt > sample.sampleAt!
    if (!explicitPhase) return { ...snapshot('training', '官方任务名单 is_active=true'), runId: sample.runId }
  }
  // Local state follows event ordering, not API availability or elapsed time.
  const trainingIsCurrent = trainingAt > 0 && trainingAt <= now
    && (evidence.queueStatus === 'succeeded' || trainingAt >= registrationAt)
  if (trainingIsCurrent && evidence.trainingState) {
    const raw = evidence.trainingState
    const kind = raw === 'training_tick' ? 'training'
      : raw === 'layer_state_change' ? evidence.trainingPhase?.toLowerCase() ?? raw : raw
    return snapshot(kind, `训练事件 state=${raw}${evidence.trainingPhase ? `；LayerPhase.${evidence.trainingPhase}` : ''}`)
  }
  // Python worker forward-pass logs are also direct local training evidence;
  // they do not require an Electron training.state event to be present.
  if (evidence.trainingAt && evidence.trainingAt <= now && evidence.trainingAt >= trainingAt
    && evidence.trainingAt >= registrationAt
    && evidence.trainingAt > (evidence.exitedAt ?? 0) && evidence.trainingAt > (evidence.quitAt ?? 0)) {
    return snapshot('training', 'IOTA 工作进程日志：训练 forward pass')
  }
  if (evidence.queueStatus && registrationAt > 0) {
    return { ...snapshot(evidence.queueStatus, `注册接口 status=${evidence.queueStatus}`), runId: null }
  }
  return null // No log evidence is not a new fault state.
}

export function activityChanged(previous: ActivitySnapshot, current: ActivitySnapshot): boolean {
  return previous.kind !== current.kind
}
export function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds))
  const h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = value % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
export async function trackActivity(path: string, current: ActivitySnapshot | null, send: (previous: ActivitySnapshot, current: ActivitySnapshot) => Promise<void>): Promise<void> {
  if (!current) return
  let previous: ActivitySnapshot | null = null
  try { previous = JSON.parse(await readFile(path, 'utf8')) } catch {}
  const sameMiner = previous?.minerId === current.minerId
  const changed = sameMiner && activityChanged(previous!, current)
  const durations = { ...(sameMiner ? previous?.durations : {}) }
  const knownStart = (value: ActivitySnapshot): number | null => value.startedAt === null ? null : value.startedAt ?? value.observedAt
  const startedAt = sameMiner ? knownStart(previous!) ?? current.startedAt ?? null : current.startedAt ?? null
  if (changed && startedAt !== null) durations[previous!.kind] = (durations[previous!.kind] ?? 0) + Math.max(0, current.observedAt - startedAt)
  const next = { ...current, startedAt: changed ? current.startedAt ?? null : startedAt, durations }
  if (changed) await send({ ...previous!, startedAt }, next)
  // Failed delivery keeps the previous baseline and start time for retry.
  await writeFile(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
}

// Replay state transitions in log order, including explicit queued responses.
export function appLogStartedAt(records: LogRecord[], current: ActivitySnapshot, sessionStartedAt = 0): number | null {
  const sorted = records.filter(r => Number.isFinite(r.t) && r.t <= current.observedAt).sort((a, b) => a.t - b.t)
  const session = Math.max(sessionStartedAt, ...sorted.filter(r => r.line.includes('[iota-cli runIotaCli] Connecting to CHANNEL')).map(r => r.t))
  let last: { kind: string; runId: string | null; at: number } | null = null
  for (const record of sorted) {
    if (record.t < session) continue
    if (/miner process exited|\[iota-cli registerQuitHandler\] Closing IOTA Cli/.test(record.line)) {
      last = { kind: 'stopped', runId: null, at: record.t }; continue
    }
    const evidence = parseLogs([record], { sessionStartedAt: session })
    let kind: string | null = null
    let runId: string | null = null
    if (evidence.trainingUpdatedAt === record.t && evidence.trainingState) {
      kind = evidence.trainingState === 'training_tick' ? 'training'
        : evidence.trainingState === 'layer_state_change' ? evidence.trainingPhase?.toLowerCase() ?? 'layer_state_change' : evidence.trainingState
      runId = evidence.trainingRunId ?? null
    } else if (evidence.trainingAt === record.t) {
      kind = 'training'
      runId = last?.kind === 'training' ? last.runId : null
    } else if (evidence.queueUpdatedAt === record.t && evidence.queueStatus) {
      if (evidence.queueStatus === 'succeeded' && last && ['training', 'weights_uploading', 'merging_partitions'].includes(last.kind)) continue
      kind = evidence.queueStatus
    }
    if (kind && (!last || last.kind !== kind || (runId && last.runId !== runId))) last = { kind, runId, at: record.t }
  }
  return last?.kind === current.kind && (!current.runId || !last.runId || current.runId === last.runId) ? last.at : null
}

// Read-only: queries must not consume transition notifications. Prefer agent
// records; only fall back to app logs when no compatible agent record exists.
export async function activityTiming(path: string, current: ActivitySnapshot | null, records: LogRecord[] = [], sessionStartedAt = 0): Promise<{ startedAt: number; elapsedSeconds: number } | null> {
  if (!current) return null
  const valid = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0 && at >= sessionStartedAt && at <= current.observedAt
  const compatible = (value: ActivitySnapshot): boolean => value.minerId === current.minerId && value.kind === current.kind
    && (!current.runId || !value.runId || value.runId === current.runId)
  let startedAt: number | null = null
  try {
    const saved: ActivitySnapshot = JSON.parse(await readFile(path, 'utf8'))
    const at = saved.startedAt === null ? null : saved.startedAt ?? saved.observedAt
    if (compatible(saved) && valid(at)) startedAt = at
  } catch {}
  if (startedAt === null) {
    try {
      const rows = (await readFile(join(dirname(path), 'history', 'state-changes.jsonl'), 'utf8')).split('\n')
      const events = rows.flatMap(line => {
        try {
          const row = JSON.parse(line)
          return row.type === 'state_change' && row.minerId === current.minerId && typeof row.to === 'string' && valid(row.changedAt) ? [row] : []
        } catch { return [] }
      }).sort((a, b) => a.changedAt - b.changedAt)
      const latest = events.at(-1)
      if (latest && compatible({ ...latest, kind: latest.to }) && valid(latest.changedAt)) startedAt = latest.changedAt
    } catch {}
  }
  if (startedAt === null) startedAt = appLogStartedAt(records, current, sessionStartedAt)
  return startedAt === null ? null : { startedAt, elapsedSeconds: current.observedAt - startedAt }
}
