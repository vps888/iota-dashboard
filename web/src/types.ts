import type { EpochRecord } from './api.js'

export type TrainingRow = EpochRecord

export function toTrainingRows(records: EpochRecord[]): TrainingRow[] {
  return [...records].sort((a, b) => b.ts - a.ts)
}
