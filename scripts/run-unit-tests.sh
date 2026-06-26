#!/usr/bin/env bash
# Run unit tests with pre-cleanup of stale Jest workers and graceful interrupt handling.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cleanup_stale_jest() {
  while read -r pid cmd; do
    [[ -z "${pid:-}" ]] && continue
    [[ "$pid" -eq "$$" ]] && continue
    if [[ "$cmd" == *"$ROOT"* ]] && [[ "$cmd" == *jest* ]]; then
      kill "$pid" 2>/dev/null && echo "[test] stopped stale jest pid=$pid"
    fi
  done < <(pgrep -af 'jest' 2>/dev/null || true)
}

on_interrupt() {
  echo "[test] interrupted — exiting"
  cleanup_stale_jest
  exit 130
}

trap on_interrupt INT TERM

cleanup_stale_jest

npx jest --passWithNoTests --runInBand --forceExit "$@"
exit $?
