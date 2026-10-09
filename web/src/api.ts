import { validateMinerId as validateMinerIdChecksum } from '../../packages/iota-miner-tools/src/ss58.js'
import { isValidNoidAddress } from '../../packages/iota-miner-tools/src/noid.js'
import type { NoidPayment, NoidPoolSnapshot, NoidWorkerSnapshot } from '../../packages/iota-miner-tools/src/noid.js'
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
}

export interface NoidDashboardData extends NoidPoolSnapshot {
  address: string
  payments: NoidPayment[]
  fetchedAt: number
  stale: boolean
  warning: string | null
  localScheduler: {
    snapshot: LocalNoidReport | null
    reportedAtServer: number
    stale: boolean
  } | null
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
const NOID_STORAGE_KEY = 'mac-miner:noid-address'
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

export function getSavedNoidAddress(): string | null {
  const value = localStorage.getItem(NOID_STORAGE_KEY)
  return value && isValidNoidAddress(value) ? value : null
}

export function saveNoidAddress(address: string): void {
  localStorage.setItem(NOID_STORAGE_KEY, address.trim())
}

export function clearNoidAddress(): void {
  localStorage.removeItem(NOID_STORAGE_KEY)
}

export function isValidNoidAddressValue(address: string): boolean {
  return isValidNoidAddress(address.trim())
}

export async function fetchDashboard(minerId: string): Promise<DashboardData> {
  const res = await fetch(`/api/dashboard?miner=${encodeURIComponent(minerId.trim())}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchNoidDashboard(address: string): Promise<NoidDashboardData> {
  const res = await fetch(`/api/noid?address=${encodeURIComponent(address.trim())}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function createToken(minerId: string, noidAddress?: string): Promise<{ token: string; createdAt: number }> {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ miner: minerId.trim(), ...(noidAddress ? { noidAddress: noidAddress.trim() } : {}) }),
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
      .then((value) => {
        if (cancelled) return
        setData(value)
        setError(null)
        setFetchedAtMs(Date.now())
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [tick, minerId])

  useEffect(() => {
    if (!minerId) return
    const id = setInterval(() => setTick((value) => value + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [minerId])

  return {
    data,
    error,
    loading,
    fetchedAtMs,
    refresh: () => setTick((value) => value + 1),
    countdown: useCountdown(fetchedAtMs),
  }
}

export function useNoidDashboard(address: string | null): {
  data: NoidDashboardData | null
  error: string | null
  loading: boolean
  fetchedAtMs: number | null
  refresh: () => void
  countdown: number
} {
  const [data, setData] = useState<NoidDashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchedAtMs, setFetchedAtMs] = useState<number | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!address) return
    let cancelled = false
    setLoading(true)
    fetchNoidDashboard(address)
      .then((response) => {
        if (cancelled) return
        setData(response)
        setError(null)
        setFetchedAtMs(Date.now())
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [address, tick])

  useEffect(() => {
    if (!address) return
    const id = setInterval(() => setTick((value) => value + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [address])

  return {
    data,
    error,
    loading,
    fetchedAtMs,
    refresh: () => setTick((value) => value + 1),
    countdown: useCountdown(fetchedAtMs),
  }
}
