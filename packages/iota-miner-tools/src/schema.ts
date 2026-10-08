import { z } from 'zod'

const finite = z.number().finite()
const count = finite.nonnegative()
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
const hotkey = z.string().min(1)
const numberArray = z.array(finite)

function aligned<T extends z.ZodRawShape>(shape: T, fields: string[]) {
  return z.object(shape).passthrough().refine((data) => {
    const record = data as Record<string, unknown>
    const lengths = fields.map((key) => (record[key] as unknown[]).length)
    return lengths.every((length) => length === lengths[0])
  }, 'parallel arrays have different lengths')
}

const runs = z.object({
  runs: z.array(z.object({
    run_id: runId,
    state: z.string(),
    metadata: z.object({
      model_name: z.string().optional(),
      model_size: z.string().optional(),
      n_splits: count.optional(),
      description: z.string().optional(),
    }).nullable().optional(),
  }).passthrough()),
}).passthrough()

const miners = z.object({
  miners: z.array(z.object({
    hotkey,
    is_active: z.boolean(),
    timestamp: count.optional(),
    throughput: count.optional(),
    activation_count: count.optional(),
  }).passthrough()),
}).passthrough()

const rank = z.object({ rank: count.nullable().optional() }).passthrough()
const occupancy = aligned({
  run_ids: z.array(runId),
  max_miners: z.array(count),
  active_miners: z.array(count),
  slots_remaining: z.array(count),
}, ['run_ids', 'max_miners', 'active_miners', 'slots_remaining'])
const totals = z.object({
  total_amount_earned: count,
  total_amount_paid: count,
  total_amount_pending: count,
  total_amount_frozen: count,
  minimum_payout_amount: count,
}).passthrough()
const history = aligned({
  timestamps: z.array(count),
  alpha_amounts: z.array(count),
  statuses: z.array(z.string()),
}, ['timestamps', 'alpha_amounts', 'statuses'])
const metrics = aligned({
  epochs: z.array(count),
  token_counts: numberArray,
  act_contribution_percs: numberArray,
  activation_ranks: numberArray,
  num_hotkeys_in_epochs: numberArray,
  uploaded_partition_percs: numberArray,
  weight_uploaded: numberArray,
  timestamps: numberArray,
}, ['epochs', 'token_counts', 'act_contribution_percs', 'activation_ranks', 'num_hotkeys_in_epochs', 'uploaded_partition_percs', 'weight_uploaded', 'timestamps'])
const throughput = aligned({
  epochs: z.array(count),
  throughputs: numberArray,
  throughput_moving_avgs: numberArray,
  timestamps: numberArray,
}, ['epochs', 'throughputs', 'throughput_moving_avgs', 'timestamps'])
const tokens = z.object({
  data_points: z.array(z.object({
    timestamp: count,
    token_count: count,
    network_tokens: count,
    contribution_fraction: finite,
  })),
}).passthrough()

const noidReport = z.object({
  mode: z.enum(['training', 'default', 'disabled', 'unmanaged', 'error']),
  running: z.boolean().nullable(),
  cpuDuty: z.number().int().min(10).max(100).nullable(),
  gpuDuty: z.number().int().min(10).max(100).nullable(),
  cpuRate: count.nullable(),
  gpuRate: count.nullable(),
  accepted: z.number().int().nonnegative().nullable(),
  rejected: z.number().int().nonnegative().nullable(),
  stale: z.number().int().nonnegative().nullable(),
}).strict()

export const localReportInput = z.object({
  status: z.enum(['paused', 'starting', 'queued', 'training', 'waiting', 'abnormal']),
  description: z.string().max(200),
  queuePosition: finite.nullable(),
  controlConnected: z.boolean(),
  restarts: z.number().int().nonnegative(),
  uptimeSec: z.number().int().nonnegative(),
  reportedAt: z.number().int().positive(),
  os: z.enum(['macos', 'linux']),
  agentVersion: z.string().max(16),
  noid: noidReport.nullable().optional(),
}).strict()

export type LocalReportInput = z.infer<typeof localReportInput>

export function upstreamKind(path: string): keyof typeof schemas {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')) throw new Error('非法的官方 API 路径')
  const url = new URL(path, 'https://iota-web.api.macrocosmos.ai')
  const keys = [...url.searchParams.keys()]
  if (url.pathname === '/runs' && keys.length === 0) return 'runs'
  if (url.pathname === '/v1/runs_occupancy' && keys.length === 0) return 'occupancy'
  if (url.pathname === '/miners' && keys.length === 1 && keys[0] === 'run_id' && runId.safeParse(url.searchParams.get('run_id')).success) return 'miners'
  if (/^\/v1\/epoch_miner_scores\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/hotkeys\/[1-9A-HJ-NP-Za-km-z]{45,55}\/run_level_rank$/.test(url.pathname) && keys.length === 0) return 'rank'
  if (/^\/v1\/entitlements\/totals\/hotkey\/[1-9A-HJ-NP-Za-km-z]{45,55}$/.test(url.pathname) && keys.length === 0) return 'totals'
  if (/^\/v1\/entitlements\/history\/hotkey\/[1-9A-HJ-NP-Za-km-z]{45,55}$/.test(url.pathname) && keys.length === 0) return 'history'
  const series = url.pathname.match(/^\/v1\/epoch_miner_scores\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/hotkeys\/[1-9A-HJ-NP-Za-km-z]{45,55}\/(metrics|throughput)$/)
  const expectedSeriesKeys = series?.[1] === 'throughput' ? 2 : 1
  if (series && keys.length === expectedSeriesKeys && new Set(keys).size === keys.length && keys.every((key) => key === 'period' || (series[1] === 'throughput' && key === 'moving_average_window')) && keys.includes('period') && url.searchParams.get('period') === 'week' && (series[1] !== 'throughput' || url.searchParams.get('moving_average_window') === '3')) return series[1] as 'metrics' | 'throughput'
  if (/^\/miners\/[1-9A-HJ-NP-Za-km-z]{45,55}\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/tokens$/.test(url.pathname) && keys.length === 1 && keys[0] === 'period' && url.searchParams.get('period') === 'week') return 'tokens'
  throw new Error('非法的官方 API 路径')
}

const schemas = { runs, occupancy, miners, rank, totals, history, metrics, throughput, tokens }

export function parseOfficialPayload(path: string, value: unknown): unknown {
  const result = schemas[upstreamKind(path)].safeParse(value)
  if (!result.success) throw new Error('官方数据格式异常')
  return result.data
}

export type OfficialRuns = z.infer<typeof runs>
export type OfficialMinerList = z.infer<typeof miners>
export type OfficialMetrics = z.infer<typeof metrics>
export type OfficialThroughput = z.infer<typeof throughput>
export type OfficialTokens = z.infer<typeof tokens>
export type OfficialOccupancy = z.infer<typeof occupancy>
export type OfficialTotals = z.infer<typeof totals>
export type OfficialHistory = z.infer<typeof history>
