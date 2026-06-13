#!/usr/bin/env bash
# Run integration connection tests with cleanup before/after.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash "$ROOT/scripts/stop-dev-services.sh"
trap 'bash "$ROOT/scripts/stop-dev-services.sh"' EXIT INT TERM

exec npx ts-node --transpile-only tests/integration/connections.ts "$@"
