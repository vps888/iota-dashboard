import { readFile, writeFile } from 'node:fs/promises'
import type { Evidence } from './guardian.js'

// Unknown future registration/state values are retained, not silently discarded.
export type ActivityKind = string
export interface ActivitySnapshot {
  minerId: string
  kind: ActivityKind
  runId: string | null
  observedAt: number
  source: string
  queuePosition: number | null
  startedAt?: number
  durations?: Record<string, number>
}
export const ACTIVITY_LABELS: Record<string, string> = {
  stopped: '未运行', queued: '排队中', confirming: '确认中', confirmed: '已确认',
  processing: '注册处理中', succeeded: '注册成功，等待训练状态', failed: '注册失败',
  waiting_training: '等待训练任务', resetting: '重置中', training: '训练中',
  weights_uploading: '权重上传中', merging_partitions: '分区合并中',
}
export function activityLabel(kind: string): string { return ACTIVITY_LABELS[kind] ?? kind }

export function resolveActivity(minerId: string, evidence: Evidence, appRunning: boolean, now: number): ActivitySnapshot | null {
  const snapshot = (kind: string, source: string): ActivitySnapshot => ({
    minerId, kind, runId: evidence.trainingRunId ?? null, observedAt: now, source,
    queuePosition: kind === 'queued' ? evidence.queuePosition : null,
  })
  if (!appRunning) return snapshot('stopped', '本机进程快照：IOTA 主程序未运行')
  const registrationAt = evidence.queueUpdatedAt ?? 0
  const trainingAt = evidence.trainingUpdatedAt ?? 0
  // Registration polls do not demote an established training state. A new
  // registration attempt or a newer non-success registration event can supersede it.
  const trainingIsCurrent = trainingAt > 0 && trainingAt >= (evidence.queueStartedAt ?? 0)
    && (evidence.queueStatus === 'succeeded' || trainingAt >= registrationAt)
  if (trainingIsCurrent && evidence.trainingState) {
    const raw = evidence.trainingState
    const kind = raw === 'training_tick' ? 'training'
      : raw === 'layer_state_change' ? evidence.trainingPhase?.toLowerCase() ?? raw : raw
    return snapshot(kind, `训练事件 state=${raw}${evidence.trainingPhase ? `；LayerPhase.${evidence.trainingPhase}` : ''}`)
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
  return `${h ? `${h}小时` : ''}${h || m ? `${m}分` : ''}${s}秒`
}
export async function trackActivity(path: string, current: ActivitySnapshot | null, send: (previous: ActivitySnapshot, current: ActivitySnapshot) => Promise<void>): Promise<void> {
  if (!current) return
  let previous: ActivitySnapshot | null = null
  try { previous = JSON.parse(await readFile(path, 'utf8')) } catch {}
  const sameMiner = previous?.minerId === current.minerId
  const changed = sameMiner && activityChanged(previous!, current)
  const durations = { ...(sameMiner ? previous?.durations : {}) }
  const startedAt = sameMiner ? previous?.startedAt ?? previous!.observedAt : current.observedAt
  if (changed) durations[previous!.kind] = (durations[previous!.kind] ?? 0) + Math.max(0, current.observedAt - startedAt)
  const next = { ...current, startedAt: changed ? current.observedAt : startedAt, durations }
  if (changed) await send({ ...previous!, startedAt }, next)
  // Failed delivery keeps the previous baseline and start time for retry.
  await writeFile(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
}
