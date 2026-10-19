import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Exercise the real release script, but never authenticate, publish or install on npm.
for (const scenario of ['published', 'propagating', 'invalid']) {
  test(`publish verification: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'miner-agent-publish-test-'))
    try {
      writeFileSync(join(dir, 'npm'), `#!/usr/bin/env bash
set -eu
case "$1" in
  whoami) echo test-user ;;
  view)
    # Pre-publish existence check must report that the version is still unpublished.
    if [[ "$*" != *"dist.tarball"* ]]; then exit 1; fi
    count=0
    if [[ -f "$MOCK_DIR/count" ]]; then count=$(cat "$MOCK_DIR/count"); fi
    count=$((count + 1)); echo "$count" > "$MOCK_DIR/count"
    if [[ "$SCENARIO" == propagating && "$count" == 1 ]]; then exit 1; fi
    version=$(node -p "require('./packages/iota-local-agent/package.json').version")
    if [[ "$SCENARIO" == invalid ]]; then version=0.0.0; fi
    printf '{"version":"%s","dist.tarball":"https://registry.npmjs.org/miner-agent/-/release.tgz","bin":{"ma":"dist/cli.js"}}\\n' "$version"
    ;;
  install)
    mkdir -p "$3/node_modules/.bin"
    printf '#!/usr/bin/env bash\\necho mock-cli-ok\\n' > "$3/node_modules/.bin/ma"
    chmod +x "$3/node_modules/.bin/ma"
    ;;
esac
`, { mode: 0o755 })
      writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
      const result = spawnSync('bash', [fileURLToPath(new URL('./publish-miner-agent.sh', import.meta.url))], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MOCK_DIR: dir, SCENARIO: scenario },
        encoding: 'utf8', timeout: 30000,
      })
      assert.ifError(result.error)
      const output = result.stdout + result.stderr
      if (scenario === 'invalid') {
        assert.equal(result.status, 1, output)
        assert.match(output, /metadata does not match/)
        assert.match(output, /not verifiable on npm after 60 attempts/)
        assert.doesNotMatch(output, /Verified usable release/)
      } else {
        assert.equal(result.status, 0, output)
        assert.match(output, /mock-cli-ok/)
        assert.match(output, /Verified usable release/)
        assert.equal((output.match(/retrying in/g) ?? []).length, scenario === 'propagating' ? 1 : 0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
