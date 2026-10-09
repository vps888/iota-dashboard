export const NOID_DECIMALS = 6
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const NOID_CHECKSUM = 0x2bc830a3

export interface NoidWorkerSnapshot {
  hashrateHps: number | null
  accepted: number | null
  rejected: number | null
  stale: number | null
  online: boolean | null
  lastSeenAgoSec: number | null
}

export interface NoidPoolSnapshot {
  found: boolean
  hashrateHps: number | null
  workersOnline: number | null
  workers: NoidWorkerSnapshot[]
  shares: {
    accepted10m: number | null
    accepted1h: number | null
    accepted24h: number | null
  }
  balanceAtomic: {
    pending: string | null
    confirmed: string | null
    paid: string | null
  }
  payoutAtomic: {
    minimum: string | null
    remaining: string | null
  }
}

export interface NoidPayment {
  amountAtomic: string
  txid: string | null
  status: string
  createdAt: number | null
}

export function isValidNoidAddress(input: string): boolean {
  const value = input.trim()
  if (value !== value.toLowerCase() || !value.startsWith('o1') || value.length < 14 || value.length > 90) return false
  let checksum = 1
  for (const valuePart of [3, 0, 15, ...Array.from(value.slice(2), (char) => BECH32_ALPHABET.indexOf(char))]) {
    if (valuePart < 0) return false
    const top = checksum >>> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ valuePart
    for (let i = 0; i < BECH32_GENERATORS.length; i += 1) {
      if (((top >>> i) & 1) !== 0) checksum ^= BECH32_GENERATORS[i]!
    }
  }
  return checksum === NOID_CHECKSUM
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid NOID pool response')
  return value as Record<string, unknown>
}

function nonnegativeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  return null
}

function atomicString(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}

function statusString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 ? value : null
}

function normalizeWorker(value: unknown): NoidWorkerSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const worker = value as Record<string, unknown>
  return {
    hashrateHps: nonnegativeNumber(worker.hashrate),
    accepted: nonnegativeNumber(worker.accepted),
    rejected: nonnegativeNumber(worker.rejected),
    stale: nonnegativeNumber(worker.stale),
    online: typeof worker.online === 'boolean' ? worker.online : null,
    lastSeenAgoSec: nonnegativeNumber(worker.lastSeenAgo),
  }
}

export function normalizeNoidPoolSnapshot(value: unknown, requestedAddress: string): NoidPoolSnapshot {
  const data = record(value)
  if (data.coin !== 'parano1d' || data.address !== requestedAddress || typeof data.found !== 'boolean') {
    throw new Error('NOID pool response identity mismatch')
  }
  const shares = record(data.shares ?? {})
  const balance = record(data.balance ?? {})
  const payout = record(data.payout ?? {})
  const workers = Array.isArray(data.workers) ? data.workers.map(normalizeWorker).filter((worker): worker is NoidWorkerSnapshot => worker !== null) : []
  return {
    found: data.found,
    hashrateHps: nonnegativeNumber(data.hashrate),
    workersOnline: nonnegativeNumber(data.workersOnline),
    workers,
    shares: {
      accepted10m: nonnegativeNumber(shares.accepted10m),
      accepted1h: nonnegativeNumber(shares.accepted1h),
      accepted24h: nonnegativeNumber(shares.accepted24h),
    },
    balanceAtomic: {
      pending: atomicString(balance.pending),
      confirmed: atomicString(balance.confirmed),
      paid: atomicString(balance.paid),
    },
    payoutAtomic: {
      minimum: atomicString(payout.minPayout),
      remaining: atomicString(payout.remaining),
    },
  }
}

export function normalizeNoidPayments(value: unknown, requestedAddress: string): NoidPayment[] {
  const data = record(value)
  if (data.coin !== 'parano1d' || data.address !== requestedAddress || !Array.isArray(data.rows)) {
    throw new Error('NOID payment response identity mismatch')
  }
  return data.rows.slice(0, 100).flatMap((item): NoidPayment[] => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const amountAtomic = atomicString(row.amount)
    const status = statusString(row.status)
    if (amountAtomic === null || status === null) return []
    const createdAt = typeof row.created_at === 'string' ? Date.parse(row.created_at) / 1000 : nonnegativeNumber(row.created_at)
    return [{
      amountAtomic,
      txid: typeof row.txid === 'string' && row.txid.length <= 128 ? row.txid : null,
      status,
      createdAt: createdAt !== null && Number.isFinite(createdAt) ? createdAt : null,
    }]
  })
}

export function formatNoidAtomicUnits(value: string | null | undefined): string {
  if (!value || !/^\d+$/.test(value)) return '—'
  const units = BigInt(value)
  const scale = 10n ** BigInt(NOID_DECIMALS)
  const whole = (units / scale).toLocaleString('zh-CN')
  const fraction = (units % scale).toString().padStart(NOID_DECIMALS, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
