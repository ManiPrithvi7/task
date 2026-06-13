#!/usr/bin/env bash
# Run unit tests with pre/post cleanup so background services and stale jest exit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash "$ROOT/scripts/stop-dev-services.sh"
trap 'bash "$ROOT/scripts/stop-dev-services.sh"' EXIT INT TERM

exec npx jest --passWithNoTests --runInBand --forceExit "$@"
