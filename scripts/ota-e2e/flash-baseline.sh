#!/usr/bin/env bash
# Flash baseline firmware (4.3.0-mvp) to ESP32-S3 for OTA E2E.
# Requires membership in the dialout group for /dev/ttyACM0:
#   sudo usermod -aG dialout "$USER" && newgrp dialout
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MQTTCLIENT="${MQTTCLIENT_DIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)/mqttclient}"
IDF_EXPORT="${IDF_EXPORT:-$HOME/.local/share/Trash/files/statsclient/esp-idf/export.sh}"
PORT="${ESP_PORT:-/dev/ttyACM0}"

if [[ ! -r "$PORT" ]]; then
  echo "Cannot read $PORT — add user to dialout: sudo usermod -aG dialout \$USER" >&2
  echo "Then log out/in or run: newgrp dialout" >&2
  exit 1
fi

if [[ ! -f "$IDF_EXPORT" ]]; then
  echo "ESP-IDF export.sh not found at $IDF_EXPORT" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$IDF_EXPORT"
cd "$MQTTCLIENT"

echo "Flashing baseline to $PORT (CONFIG_FIRMWARE_VERSION=4.3.0-mvp)..."
idf.py -p "$PORT" flash

echo ""
echo "Start monitor: idf.py -p $PORT monitor"
echo "Expect: MQTT_EVENT_CONNECTED (client_id=DEVICE-19), subscribe proof.mqtt/DEVICE-19/# OK"
