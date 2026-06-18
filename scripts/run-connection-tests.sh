#!/usr/bin/env bash
# Run integration connection tests with graceful interrupt handling.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

on_interrupt() {
  echo "[test:connections] interrupted — exiting"
  exit 130
}

trap on_interrupt INT TERM

npx ts-node --transpile-only tests/integration/connections.ts "$@"
exit $?
