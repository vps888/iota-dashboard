#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PACKAGE_DIR="packages/iota-local-agent"
PACKAGE_NAME="$(node -p "require('./${PACKAGE_DIR}/package.json').name")"
PACKAGE_VERSION="$(node -p "require('./${PACKAGE_DIR}/package.json').version")"

printf 'Preparing %s@%s\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"

printf '\n==> Log in to npm (browser/passkey)\n'
npm login --registry=https://registry.npmjs.org/ --auth-type=web

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

printf '\nPublished %s@%s\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"
