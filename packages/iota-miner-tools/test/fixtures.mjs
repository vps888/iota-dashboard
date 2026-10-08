import { blake2b } from '@noble/hashes/blake2.js'
import { base58 } from '@scure/base'

const body = new Uint8Array(33)
body[0] = 42
for (let i = 1; i < body.length; i += 1) body[i] = i
const preimage = new Uint8Array([...new TextEncoder().encode('SS58PRE'), ...body])
const checksum = blake2b(preimage, { dkLen: 64 }).subarray(0, 2)
export const validMinerId = base58.encode(new Uint8Array([...body, ...checksum]))
