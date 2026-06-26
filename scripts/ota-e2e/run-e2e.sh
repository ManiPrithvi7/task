#!/usr/bin/env bash
# Push OTA when device publishes /active.
# Default: server admin API. LAN lab: OTA_E2E_LAN=1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export OTA_FIRMWARE_VERSION="${OTA_FIRMWARE_VERSION:-4.3.1-mvp}"
export MQTT_BROKER="${MQTT_BROKER:-broker.withproof.io}"
export MQTT_PORT="${MQTT_PORT:-8883}"
export MQTT_TLS_REJECT_UNAUTHORIZED="${MQTT_TLS_REJECT_UNAUTHORIZED:-false}"
DEVICE_ID="${1:-DEVICE-19}"
LAN_MODE="${OTA_E2E_LAN:-0}"

if [[ "$LAN_MODE" == "1" || "$LAN_MODE" == "true" ]]; then
  if [[ -z "${LAN_IP:-}" ]]; then
    LAN_IP=$(ip -4 -o addr show scope global 2>/dev/null \
      | awk '!/docker|br-|veth/ {print $4}' \
      | cut -d/ -f1 \
      | grep -E '^(192\.168\.|10\.)' \
      | head -1)
  fi
  LAN_IP="${LAN_IP:-$(hostname -I | awk '{print $1}')}"
  if [[ -z "$LAN_IP" || "$LAN_IP" == *"<"* || "$LAN_IP" == *">"* ]]; then
    echo "ERROR: Set LAN_IP for LAN E2E mode." >&2
    exit 1
  fi
  if [[ ! -f "$SCRIPT_DIR/artifacts/manifest.json" ]]; then
    echo "Missing manifest.json — run sign-firmware.sh" >&2
    exit 1
  fi
  echo "Mode: LAN HTTP (dev only) — $LAN_IP"
  echo "Device: $DEVICE_ID"
  if ! curl -sfI "http://127.0.0.1:8765/firmware-target.bin" >/dev/null 2>&1; then
    echo "Starting firmware HTTP server on :8765..."
    python3 "$SCRIPT_DIR/firmware_server.py" &
    HTTP_PID=$!
    sleep 1
    trap 'kill $HTTP_PID 2>/dev/null || true' EXIT
  fi
  cd "$REPO_ROOT"
  OTA_E2E_LAN=1 NODE_PATH="$REPO_ROOT/node_modules" node "$SCRIPT_DIR/push-ota-on-active.js" "$LAN_IP" "$DEVICE_ID"
  exit 0
fi

if [[ -z "${AUTH_TOKEN:-}" ]]; then
  echo "ERROR: AUTH_TOKEN required for server push." >&2
  echo "  AUTH_TOKEN=<jwt> OTA_API_BASE=http://localhost:3002 $0 $DEVICE_ID" >&2
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/artifacts/manifest.json" ]] && [[ -z "${OTA_FIRMWARE_VERSION:-}" ]]; then
  echo "Missing manifest.json or set OTA_FIRMWARE_VERSION" >&2
  exit 1
fi

API_BASE="${OTA_API_BASE:-${PUBLIC_APP_URL:-http://localhost:3002}}"
echo "Mode: server push (domain proxy / OCI per server config)"
echo "Device: $DEVICE_ID"
echo "Version: $OTA_FIRMWARE_VERSION"
echo "Server: $API_BASE"
echo ""

cd "$REPO_ROOT"
NODE_PATH="$REPO_ROOT/node_modules" node "$SCRIPT_DIR/push-ota-on-active.js" "$DEVICE_ID"
