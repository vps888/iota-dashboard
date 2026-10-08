import { validateMinerId as validateMinerIdChecksum } from '../../packages/iota-miner-tools/src/ss58.js'
import type { OfficialStatus } from '../../packages/iota-miner-tools/src/types.js'
export interface MinerStatus {
  hotkey: string
  shortId: string
  name: string
  runId: string | null
  online: boolean | null
  training: boolean | null
  tokensPerActivation: number
  throughput: number
  throughputAvg: number
  activations: number
  tokens: number
  partitionLabel: string | null
  lastContributionAt: number | null
  weightUploaded: number
  latestSampleAt: number | null
  epochRecords: EpochRecord[]
}

export interface EpochRecord {
  epoch: number
  ts: number
  tokens: number
  rank: number | null
  numHotkeys: number | null
  contribution: number | null
}

export interface Payment {
  ts: number
  amount: number
  status: string
}

export interface RunInfo {
  runId: string
  tier: string | null
  model: string | null
  modelSize: string | null
  splits: number | null
  maxMiners: number
  activeMiners: number
  slotsRemaining: number
}

export interface LocalNoidReport {
  mode: 'training' | 'default' | 'disabled' | 'unmanaged' | 'error'
  running: boolean | null
  cpuDuty: number | null
  gpuDuty: number | null
  cpuRate: number | null
  gpuRate: number | null
  accepted: number | null
  rejected: number | null
  stale: number | null
}

export interface LocalReport {
  status: 'paused' | 'starting' | 'queued' | 'training' | 'waiting' | 'abnormal'
  description: string
  queuePosition: number | null
  controlConnected: boolean
  restarts: number
  uptimeSec: number
  os: string
  agentVersion: string
  reportedAt: number
  reportedAtServer: number
  stale: boolean
  noid: LocalNoidReport | null
}

export interface DashboardData {
  fetchedAt: number
  lookup: {
    status: OfficialStatus
    checkedAt: number
    lastSuccessfulFetchAt: number | null
    coverage: { successful: number; total: number }
    stale: boolean
    warning: string | null
    sampleAt: number | null
  }
  miner: MinerStatus | null
  todayEarned: number
  yesterdayEarned: number
  totals: {
    earned: number
    paid: number
    pending: number
    frozen: number
    minimumPayout: number
  }
  payments: Payment[]
  runs: RunInfo[]
  usdPerIota: number | null
  localReport: LocalReport | null
}

const STORAGE_KEY = 'iota-dashboard:miner-id'
const REFRESH_MS = 60_000

export function getSavedMinerId(): string | null {
  const v = localStorage.getItem(STORAGE_KEY)
  return v && validateMinerIdChecksum(v).valid ? v : null
}

export function saveMinerId(id: string): void {
  localStorage.setItem(STORAGE_KEY, id.trim())
}

export function clearMinerId(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function isValidMinerId(id: string): boolean {
  return validateMinerIdChecksum(id.trim()).valid
}

export async function fetchDashboard(minerId: string): Promise<DashboardData> {
  const res = await fetch(`/api/dashboard?miner=${encodeURIComponent(minerId.trim())}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function createToken(minerId: string): Promise<{ token: string; createdAt: number }> {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ miner: minerId.trim() }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function revokeToken(token: string): Promise<void> {
  await fetch('/api/token', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

export function useCountdown(lastFetchMs: number | null): number {
  const [remaining, setRemaining] = useState(0)
  useEffect(() => {
    const tick = () => {
      if (lastFetchMs === null) return setRemaining(0)
      const elapsed = Date.now() - lastFetchMs
      setRemaining(Math.max(0, Math.ceil((REFRESH_MS - elapsed) / 1000)))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastFetchMs])
  return remaining
}

import { useEffect, useState } from 'react'

export function useDashboard(minerId: string | null): {
  data: DashboardData | null
  error: string | null
  loading: boolean
  fetchedAtMs: number | null
  refresh: () => void
  countdown: number
} {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchedAtMs, setFetchedAtMs] = useState<number | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!minerId) return
    let cancelled = false
    setLoading(true)
    fetchDashboard(minerId)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
        setFetchedAtMs(Date.now())
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tick, minerId])

  useEffect(() => {
    if (!minerId) return
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [minerId])

  const countdown = useCountdown(fetchedAtMs)

  return {
    data,
    error,
    loading,
    fetchedAtMs,
    refresh: () => setTick((t) => t + 1),
    countdown,
  }
}
