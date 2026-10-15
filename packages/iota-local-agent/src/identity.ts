import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { blake2b } from '@noble/hashes/blake2.js'
import { base58 } from '@scure/base'
import { validateMinerId } from './ss58.js'
import { logRecords } from './guardian.js'

const BT_WALLETS = join(homedir(), '.bittensor', 'wallets')
const MANAGED_KEY_EXTENSIONS = new Set(['.pub', '.json', '.txt'])
function publicKeyToSs58(hex: string): string {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex')
  if (bytes.length !== 32) throw new Error('publicKey 长度不是 32 字节')
  const prefixAndKey = new Uint8Array([42, ...bytes])
  const checksum = blake2b(new Uint8Array([...new TextEncoder().encode('SS58PRE'), ...prefixAndKey]), { dkLen: 64 })
  return base58.encode(new Uint8Array([...prefixAndKey, checksum[0]!, checksum[1]!]))
}

export interface LocalMinerIdentity { minerId: string; walletName: string; hotkeyName: string; source: string }
export interface IdentityScan { identities: LocalMinerIdentity[]; recommendedMinerId: string | null; warnings: string[] }

export async function detectLocalMinerIds(): Promise<IdentityScan> {
  const warnings: string[] = []
  const identities = new Map<string, LocalMinerIdentity>()
  const records = await logRecords()
  const currentWallet = records.some((candidate) => /Initializing Bittensor wallet:\s*iota\s+and hotkey:\s*iota_miner/.test(candidate.line))
  for (const record of records) {
    const match = /Payout coldkey:\s*([1-9A-HJ-NP-Za-km-z]{45,55})/.exec(record.line)
    const walletAddress = match?.[1]
    const nearbyWalletHint = records.some((candidate) => Math.abs(candidate.t - record.t) <= 120 && /Initializing Bittensor wallet:\s*iota\s+and hotkey:\s*iota_miner/.test(candidate.line))
    if (walletAddress && (currentWallet || nearbyWalletHint) && validateMinerId(walletAddress).valid) identities.set(walletAddress, { minerId: walletAddress, walletName: 'iota', hotkeyName: 'iota_miner', source: 'IOTA current payout coldkey log' })
  }
  try {
    const walletNames = await (await import('node:fs/promises')).readdir(BT_WALLETS)
    for (const walletName of walletNames) {
      const hotkeysDir = join(BT_WALLETS, walletName, 'hotkeys')
      let files: string[]
      try { files = await (await import('node:fs/promises')).readdir(hotkeysDir) } catch { continue }
      for (const hotkeyName of files) {
        if (!MANAGED_KEY_EXTENSIONS.has(hotkeyName.slice(hotkeyName.lastIndexOf('.')) === hotkeyName ? '' : hotkeyName.slice(hotkeyName.lastIndexOf('.')))) continue
        const path = join(hotkeysDir, hotkeyName)
        try {
          const payload = JSON.parse(await readFile(path, 'utf8')) as { publicKey?: unknown; accountId?: unknown }
          const publicHex = typeof payload.publicKey === 'string' ? payload.publicKey : typeof payload.accountId === 'string' ? payload.accountId : null
          if (!publicHex) continue
          const minerId = publicKeyToSs58(publicHex)
          if (!validateMinerId(minerId).valid) continue
          const normalizedHotkey = hotkeyName.replace(/\.(pub|json|txt)$/, '')
          identities.set(minerId, { minerId, walletName, hotkeyName: normalizedHotkey, source: 'Bittensor public wallet metadata' })
        } catch {
          // Ignore unreadable files; never inspect secret key fields or files without public metadata.
        }
      }
    }
  } catch (error) {
    warnings.push(`无法枚举本地 Bittensor 公钥目录：${error instanceof Error ? error.message : String(error)}`)
  }
  const deduped = new Map<string, LocalMinerIdentity>()
  for (const identity of identities.values()) {
    const previous = deduped.get(identity.minerId)
    if (!previous || (previous.source.includes('Bittensor') === false && identity.source.includes('Bittensor'))) deduped.set(identity.minerId, identity)
  }
  const candidates = [...deduped.values()]
  const activeHints = matchLogWalletHint(records.map((record) => record.line), candidates)
  return { identities: candidates, recommendedMinerId: activeHints.length === 1 ? activeHints[0]!.minerId : null, warnings }
}

export function matchLogWalletHint(lines: string[], identities: LocalMinerIdentity[]): LocalMinerIdentity[] {
  const hints = new Set<string>()
  for (const line of lines) {
    const match = /Initializing Bittensor wallet:\s*([^\s]+)\s+and hotkey:\s*([^\s.]+)/.exec(line)
    if (match) hints.add(`${match[1]}/${match[2]}`)
  }
  return identities.filter((identity) => hints.has(`${identity.walletName}/${identity.hotkeyName}`))
}
