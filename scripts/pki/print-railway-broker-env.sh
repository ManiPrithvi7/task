#!/usr/bin/env bash
# Print Railway NanoMQ broker TLS env values after broker cert regen.
# Root CA is unchanged — update only broker cert + key on the NanoMQ service.
#
# Outputs base64 PEM (same style as MQTT_TLS_*_BASE64 in the Proof app) plus raw PEM for reference.
#
# Usage (from repo root):
#   ./scripts/pki/print-railway-broker-env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CRT="$ROOT/broker/certs/broker.crt"
KEY="$ROOT/broker/certs/broker.key"

for f in "$CRT" "$KEY"; do
  [[ -f "$f" ]] || { echo "Missing $f — run ./scripts/pki/generate-broker-cert.sh first" >&2; exit 1; }
done

b64_one_line() {
  base64 -w 0 "$1"
}

CRT_B64="$(b64_one_line "$CRT")"
KEY_B64="$(b64_one_line "$KEY")"

echo "# Deploy to Railway NanoMQ service (Root CA / MQTT_TLS_CA_BASE64 unchanged):"
echo "# 1. Set broker cert + key base64 vars below (or paste PEM section if your service uses raw PEM)"
echo "# 2. Restart NanoMQ"
echo ""
echo "# --- Base64 (recommended — matches Proof app MQTT_TLS_*_BASE64 style) ---"
echo ""
echo "NANOMQ_TLS_CERT_BASE64=${CRT_B64}"
echo ""
echo "NANOMQ_TLS_KEY_BASE64=${KEY_B64}"
echo ""
echo "# Aliases if your NanoMQ/Railway template uses MQTT-style names:"
echo "# MQTT_TLS_BROKER_CERT_BASE64=${CRT_B64}"
echo "# MQTT_TLS_BROKER_KEY_BASE64=${KEY_B64}"
echo ""
echo "# --- Raw PEM (reference / services that accept multiline PEM env) ---"
echo ""
echo "-----BEGIN NANOMQ_TLS_CERT-----"
cat "$CRT"
echo "-----END NANOMQ_TLS_CERT-----"
echo ""
echo "-----BEGIN NANOMQ_TLS_KEY-----"
cat "$KEY"
echo "-----END NANOMQ_TLS_KEY-----"
