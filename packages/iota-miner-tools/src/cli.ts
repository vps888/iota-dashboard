#!/usr/bin/env node
import { officialClient } from './official.js'
import { minerIdError } from './ss58.js'
import { formatOfficialLookup } from './format.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const minerId = args.find((arg) => arg !== '--json')

if (!minerId || args.some((arg) => arg !== '--json' && arg !== minerId)) {
  process.stderr.write('用法: iota-miner <Miner ID> [--json]\n')
  process.exitCode = 2
} else {
  const validationError = minerIdError(minerId)
  if (validationError) {
    process.stderr.write(`${validationError}\n`)
    process.exitCode = 2
  } else {
    try {
      const lookup = await officialClient.lookupMiner(minerId)
      if (json) {
        process.stdout.write(`${JSON.stringify(lookup, null, 2)}\n`)
      } else {
        process.stdout.write(formatOfficialLookup(minerId, lookup) + '\n')
      }
    } catch (error) {
      process.stderr.write(`查询失败: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  }
}
