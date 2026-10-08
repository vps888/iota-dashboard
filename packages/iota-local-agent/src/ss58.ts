import { blake2b } from '@noble/hashes/blake2.js'
import { base58 } from '@scure/base'

// 与 iota-miner-tools/src/ss58.ts 保持一致的 SS58 校验;独立发布所以内联
const SS58_PREFIX = new TextEncoder().encode('SS58PRE')
const GENERIC_SUBSTRATE_PREFIX = 42

export type MinerIdValidation =
  | { valid: true }
  | { valid: false; reason: 'empty' | 'charset' | 'length' | 'checksum' | 'network' }

export function validateMinerId(address: string): MinerIdValidation {
  const trimmed = address.trim()
  if (!trimmed) return { valid: false, reason: 'empty' }

  let raw: Uint8Array
  try {
    raw = base58.decode(trimmed)
  } catch {
    return { valid: false, reason: 'charset' }
  }

  if (raw.length !== 35 && raw.length !== 36) return { valid: false, reason: 'length' }

  const first = raw[0]
  if (first === undefined || first >= 128) return { valid: false, reason: 'charset' }

  let prefixLength: number
  let networkPrefix: number
  if (first < 64) {
    prefixLength = 1
    networkPrefix = first
  } else {
    const second = raw[1]
    if (second === undefined) return { valid: false, reason: 'length' }
    prefixLength = 2
    networkPrefix = ((first & 0b0011_1111) << 2) | (second >> 6) | ((second & 0b0011_1111) << 8)
  }
  if (raw.length - prefixLength !== 34) return { valid: false, reason: 'length' }

  const body = raw.subarray(0, raw.length - 2)
  const checksum = raw.subarray(raw.length - 2)
  const expected = blake2b(new Uint8Array([...SS58_PREFIX, ...body]), { dkLen: 64 })
  if (expected[0] !== checksum[0] || expected[1] !== checksum[1]) return { valid: false, reason: 'checksum' }
  if (networkPrefix !== GENERIC_SUBSTRATE_PREFIX) return { valid: false, reason: 'network' }
  return { valid: true }
}
