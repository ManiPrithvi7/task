#!/usr/bin/env bash
# Run OTA E2E test (HTTP server + MQTT push). Flash baseline first via flash-baseline.sh.
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
  # Prefer explicit LAN_IP; else first RFC1918 address (skip docker bridges).
  if [[ -z "${LAN_IP:-}" ]]; then
    LAN_IP=$(ip -4 -o addr show scope global 2>/dev/null \
      | awk '!/docker|br-|veth/ {print $4}' \
      | cut -d/ -f1 \
      | grep -E '^(192\.168\.|10\.)' \
      | head -1)
  fi
  LAN_IP="${LAN_IP:-$(hostname -I | awk '{print $1}')}"

  if [[ -z "$LAN_IP" || "$LAN_IP" == *"<"* || "$LAN_IP" == *">"* ]]; then
    echo "ERROR: Set LAN_IP to your laptop IP on the same WiFi/hotspot as the ESP32." >&2
    echo "Example:" >&2
    echo "  ip -4 -o addr show scope global | awk '{print \$4}'" >&2
    echo "  OTA_E2E_LAN=1 LAN_IP=10.151.216.236 $0 $DEVICE_ID" >&2
    exit 1
  fi
fi

if [[ ! -f "$SCRIPT_DIR/artifacts/manifest.json" ]]; then
  echo "Missing manifest.json — run: OTA_FIRMWARE_VERSION=$OTA_FIRMWARE_VERSION $SCRIPT_DIR/sign-firmware.sh" >&2
  exit 1
fi

if [[ "$LAN_MODE" == "1" || "$LAN_MODE" == "true" ]]; then
  echo "Mode: LAN HTTP (dev only)"
  echo "LAN IP: $LAN_IP"
else
  echo "Mode: OCI Object Storage PAR (default — firmware must be in proof-firmware-ota bucket)"
fi
echo "Device: $DEVICE_ID"
echo "Broker: mqtts://$MQTT_BROKER:$MQTT_PORT"
echo ""
if [[ "$LAN_MODE" == "1" || "$LAN_MODE" == "true" ]]; then
  echo "Terminal 1: python3 $SCRIPT_DIR/firmware_server.py"
  echo "Terminal 2: cd ../mqttclient && idf.py -p /dev/ttyACM0 monitor"
  echo "Terminal 3: this script (push)"
  echo ""
fi

if [[ "$LAN_MODE" == "1" || "$LAN_MODE" == "true" ]]; then
  if ! curl -sfI "http://127.0.0.1:8765/firmware-target.bin" >/dev/null 2>&1; then
    echo "Starting firmware HTTP server on :8765..."
    python3 "$SCRIPT_DIR/firmware_server.py" &
    HTTP_PID=$!
    sleep 1
    trap 'kill $HTTP_PID 2>/dev/null || true' EXIT
  fi
fi

cd "$REPO_ROOT"
if [[ "$LAN_MODE" == "1" || "$LAN_MODE" == "true" ]]; then
  OTA_E2E_LAN=1 NODE_PATH="$REPO_ROOT/node_modules" node "$SCRIPT_DIR/push-ota-on-active.js" "$LAN_IP" "$DEVICE_ID"
else
  NODE_PATH="$REPO_ROOT/node_modules" node "$SCRIPT_DIR/push-ota-on-active.js" "$DEVICE_ID"
fi
