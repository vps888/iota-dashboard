export interface MinerStatus {
  hotkey: string
  shortId: string
  name: string
  runId: string
  online: boolean
  training: boolean
  tokensPerActivation: number
  throughput: number
  throughputAvg: number
  activations: number
  tokens: number
  rank: number | null
  numHotkeys: number | null
  contributionPerc: number | null
  uploadedPartition: number | null
  weightUploaded: number
  latestSampleAt: number | null
  trainingPoints: { ts: number; tokens: number; networkTokens: number; contribution: number }[]
}

export interface Payment {
  ts: number
  amount: number
  status: string
}

export interface RunInfo {
  runId: string
  maxMiners: number
  activeMiners: number
  slotsRemaining: number
}

export interface DashboardData {
  fetchedAt: number
  miner: MinerStatus | null
  todayEarned: number
  totals: {
    earned: number
    paid: number
    pending: number
    frozen: number
    minimumPayout: number
  }
  nextPayoutAt: number
  payments: Payment[]
  runs: RunInfo[]
  usdPerIota: number | null
}

const STORAGE_KEY = 'iota-dashboard:miner-id'
const MINER_ID_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{45,55}$/
const REFRESH_MS = 60_000

export function getSavedMinerId(): string | null {
  const v = localStorage.getItem(STORAGE_KEY)
  return v && MINER_ID_PATTERN.test(v) ? v : null
}

export function saveMinerId(id: string): void {
  localStorage.setItem(STORAGE_KEY, id.trim())
}

export function clearMinerId(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function isValidMinerId(id: string): boolean {
  return MINER_ID_PATTERN.test(id.trim())
}

export async function fetchDashboard(minerId: string): Promise<DashboardData> {
  const res = await fetch(`/api/dashboard?miner=${encodeURIComponent(minerId.trim())}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `HTTP ${res.status}`)
  }
  return res.json()
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
