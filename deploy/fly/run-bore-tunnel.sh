#!/usr/bin/env sh
# Expose local Mosquitto MQTTS (host :8883) to the internet via bore.pub.
#
# Prereqs:
#   - Docker compose running: `docker compose up -d` (ports 8883 published)
#   - bore installed: https://github.com/ekzhang/bore/releases
#
# Usage:
#   chmod +x deploy/fly/run-bore-tunnel.sh
#   ./deploy/fly/run-bore-tunnel.sh
#
# bore prints: "listening at bore.pub:NNNNN" — use that exact port in the client:
#   export MQTT_URL=mqtts://bore.pub:NNNNN
#   export MQTT_TLS_VERIFY_HOST=proof-mqtt.fly.dev
#
# Keep this terminal open; closing it ends the tunnel (ECONNREFUSED on clients).

set -e
PORT="${1:-8883}"
TO="${BORE_SERVER:-bore.pub}"

if ! command -v bore >/dev/null 2>&1; then
  echo "bore not found. Install e.g.:"
  echo "  mkdir -p ~/.local/bin && curl -fsSL https://github.com/ekzhang/bore/releases/download/v0.6.0/bore-v0.6.0-x86_64-unknown-linux-musl.tar.gz | tar xz -C ~/.local/bin && chmod +x ~/.local/bin/bore"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  exit 1
fi

echo "Forwarding local TCP :${PORT} -> ${TO}:<random> ..."
echo "Point statsclient at the URL bore prints (mqtts://bore.pub:<port>)."
echo ""

exec bore local "$PORT" --to "$TO"
