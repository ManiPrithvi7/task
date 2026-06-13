#!/usr/bin/env bash
# Stop background services that compete with tests (CPU, RAM, ports).
# Safe to run before/after npm test — does not disable systemd units permanently.
set +e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[test-cleanup] stopping dev services..."

# OpenClaw gateway (auto-restart agent — heavy alongside Cursor)
if systemctl --user is-active --quiet openclaw-gateway.service 2>/dev/null; then
  systemctl --user stop openclaw-gateway.service 2>/dev/null
  echo "[test-cleanup] stopped openclaw-gateway.service"
fi

# OTA E2E LAN HTTP server
if pgrep -f '[f]irmware_server\.py' >/dev/null 2>&1; then
  pkill -f 'firmware_server\.py' 2>/dev/null
  echo "[test-cleanup] stopped firmware_server.py"
fi

# Stale jest workers from interrupted prior runs (this repo only)
while read -r pid cmd; do
  [[ -z "$pid" ]] && continue
  [[ "$pid" -eq "$$" ]] && continue
  if [[ "$cmd" == *"$ROOT"* ]] && [[ "$cmd" == *jest* ]]; then
    kill "$pid" 2>/dev/null && echo "[test-cleanup] killed stale jest pid=$pid"
  fi
done < <(pgrep -af 'jest' 2>/dev/null || true)

# proofmqtt dev / OTA ports
if command -v fuser >/dev/null 2>&1; then
  fuser -k 3002/tcp 2>/dev/null && echo "[test-cleanup] freed port 3002"
  fuser -k 8765/tcp 2>/dev/null && echo "[test-cleanup] freed port 8765"
elif command -v lsof >/dev/null 2>&1; then
  lsof -ti:3002 2>/dev/null | xargs -r kill -9 2>/dev/null
  lsof -ti:8765 2>/dev/null | xargs -r kill -9 2>/dev/null
fi

echo "[test-cleanup] done"
