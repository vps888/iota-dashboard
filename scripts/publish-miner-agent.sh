#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PACKAGE_DIR="packages/iota-local-agent"
PACKAGE_NAME="$(node -p "require('./${PACKAGE_DIR}/package.json').name")"
PACKAGE_VERSION="$(node -p "require('./${PACKAGE_DIR}/package.json').version")"

printf 'Preparing %s@%s\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"

printf '\n==> Log in to npm (browser/passkey)\n'
if ! npm login --registry=https://registry.npmjs.org/ --auth-type=web; then
  printf 'npm login returned nonzero; checking whether browser authentication completed...\n'
fi

printf '\n==> Verify npm account\n'
NPM_USER="$(npm whoami --registry=https://registry.npmjs.org/)"
printf 'Authenticated as %s\n' "$NPM_USER"

if npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version >/dev/null 2>&1; then
  printf 'Error: %s@%s is already published. Bump the package version first.\n' \
    "$PACKAGE_NAME" "$PACKAGE_VERSION" >&2
  exit 1
fi

printf '\n==> Build\n'
npm run build --workspace=miner-agent

printf '\n==> Test\n'
npm test --workspace=miner-agent

printf '\n==> Verify package contents\n'
npm pack --workspace=miner-agent --dry-run

printf '\n==> Publish to npm\n'
npm publish --workspace=miner-agent --access public --auth-type=web

printf '\n==> Wait for npm registry propagation and verify package metadata\n'
MAX_ATTEMPTS=60
SLEEP_SECONDS=10
PACKAGE_METADATA=""
for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  if PACKAGE_METADATA="$(npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version dist.tarball bin --json --registry=https://registry.npmjs.org/ 2>/dev/null)" \
    && printf '%s' "$PACKAGE_METADATA" | node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        try {
          const meta = JSON.parse(input);
          const ok = meta.version === process.argv[1]
            && typeof meta.dist.tarball === "string"
            && Object.keys(meta.bin ?? {}).length === 1
            && meta.bin?.ma === "dist/cli.js";
          process.exit(ok ? 0 : 1);
        } catch { process.exit(1); }
      });
    ' "$PACKAGE_VERSION"; then
    break
  fi
  if (( attempt == MAX_ATTEMPTS )); then
    printf 'Error: %s@%s was published but is not verifiable on npm after %s attempts.\n' \
      "$PACKAGE_NAME" "$PACKAGE_VERSION" "$MAX_ATTEMPTS" >&2
    exit 1
  fi
  printf 'Registry has not exposed %s@%s yet (%s/%s); retrying in %ss...\n' \
    "$PACKAGE_NAME" "$PACKAGE_VERSION" "$attempt" "$MAX_ATTEMPTS" "$SLEEP_SECONDS"
  sleep "$SLEEP_SECONDS"
done
printf '%s\n' "$PACKAGE_METADATA"

printf '\n==> Verify fresh installation and CLI entry point\n'
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/miner-agent-publish-check.XXXXXX")"
trap 'rm -rf "$VERIFY_DIR"' EXIT
npm install --prefix "$VERIFY_DIR" --no-audit --no-fund "${PACKAGE_NAME}@${PACKAGE_VERSION}"
"$VERIFY_DIR/node_modules/.bin/ma" --help

printf '\nVerified usable release: %s@%s\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"
