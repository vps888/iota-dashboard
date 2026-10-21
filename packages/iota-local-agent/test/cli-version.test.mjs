import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

for (const flag of ['-v', '--version']) {
  test(`ma ${flag} reports package version and exits successfully`, () => {
    assert.equal(execFileSync(process.execPath, [cli, flag], { encoding: 'utf8' }), `ma ${version}\n`)
  })
}

test('help banner uses package version too', () => {
  const output = execFileSync(process.execPath, [cli], { encoding: 'utf8' })
  assert.ok(output.startsWith(`ma ${version} - `))
})
