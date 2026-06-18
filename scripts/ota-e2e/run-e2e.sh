#!/usr/bin/env bash
# Push OTA via proofmqtt server when device publishes /active (OCI presigned download_url).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export OTA_FIRMWARE_VERSION="${OTA_FIRMWARE_VERSION:-4.3.1-mvp}"
export MQTT_BROKER="${MQTT_BROKER:-broker.withproof.io}"
export MQTT_PORT="${MQTT_PORT:-8883}"
export MQTT_TLS_REJECT_UNAUTHORIZED="${MQTT_TLS_REJECT_UNAUTHORIZED:-false}"
DEVICE_ID="${1:-DEVICE-19}"

if [[ -z "${AUTH_TOKEN:-}" ]]; then
  echo "ERROR: AUTH_TOKEN required (JWT for /api/v1/admin/ota/push)." >&2
  echo "Example:" >&2
  echo "  AUTH_TOKEN=<jwt> OTA_API_BASE=http://localhost:3002 $0 $DEVICE_ID" >&2
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/artifacts/manifest.json" ]] && [[ -z "${OTA_FIRMWARE_VERSION:-}" ]]; then
  echo "Missing manifest.json — run: OTA_FIRMWARE_VERSION=$OTA_FIRMWARE_VERSION $SCRIPT_DIR/sign-firmware.sh" >&2
  exit 1
fi

API_BASE="${OTA_API_BASE:-${PUBLIC_APP_URL:-http://localhost:3002}}"
echo "Device: $DEVICE_ID"
echo "Version: $OTA_FIRMWARE_VERSION"
echo "Server: $API_BASE"
echo "Broker: mqtts://$MQTT_BROKER:$MQTT_PORT"
echo ""
echo "Ensure proofmqtt server is running with OTA_ENABLED=true and OCI credentials."
echo "Terminal 1: cd ../mqttclient && idf.py -p /dev/ttyACM0 monitor"
echo "Terminal 2: this script (server push on /active)"
echo ""

cd "$REPO_ROOT"
NODE_PATH="$REPO_ROOT/node_modules" node "$SCRIPT_DIR/push-ota-on-active.js" "$DEVICE_ID"
