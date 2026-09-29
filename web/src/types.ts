export interface TrainingRow {
  ts: number
  tokens: number
  contribution: number
}

export function toTrainingRows(
  points: { ts: number; tokens: number; networkTokens: number; contribution: number }[],
): TrainingRow[] {
  return points
    .filter((p) => p.tokens > 0)
    .map((p) => ({ ts: p.ts, tokens: p.tokens, contribution: p.contribution }))
}
