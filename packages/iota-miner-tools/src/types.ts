export type OfficialStatus =
  | 'contributing'
  | 'waiting'
  | 'idle'
  | 'not_found'
  | 'unknown'
  | 'refresh_interrupted'

export interface OfficialMinerSample {
  hotkey: string
  runId: string
  isActive: boolean
  throughput: number
  activations: number
  sampleAt: number | null
}

export interface OfficialLookup {
  status: OfficialStatus
  miner: OfficialMinerSample | null
  runId: string | null
  checkedAt: number
  lastSuccessfulFetchAt: number | null
  coverage: {
    successful: number
    total: number
  }
  stale: boolean
  warning: string | null
}
