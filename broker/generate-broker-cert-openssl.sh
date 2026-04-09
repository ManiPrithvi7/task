#!/usr/bin/env bash
# Regenerate NanoMQ broker TLS cert with CN + SAN (Railway TCP proxy, any host/IP you list).
# Requires: openssl, repo-root CA at src/certs/root-ca.{crt,key}
#
# Usage (from repo root):
#   ./broker/generate-broker-cert-openssl.sh
#
# Optional — add IP SANs for clients that connect by raw IP (comma- or space-separated):
#   BROKER_SAN_IPS="203.0.113.10,198.51.100.2" ./broker/generate-broker-cert-openssl.sh
# There is no "any IP" wildcard in x509; list each public IP you need, or rely on DNS + SNI only.
#
# Then set Railway / Render broker env:
#   NANOMQ_TLS_CA_CERT  ← src/certs/root-ca.crt (PEM)
#   NANOMQ_TLS_CERT     ← broker/certs/broker.crt (leaf)
#   NANOMQ_TLS_KEY      ← broker/certs/broker.key
#
# Node app / clients behind TCP proxy:
#   MQTT_BROKER=switchback.proxy.rlwy.net
#   MQTT_TLS_SERVERNAME=PROOF-nanomq-broker   # or MQTT_TLS_VERIFY_HOST (alias)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CA_CRT="${ROOT}/src/certs/root-ca.crt"
CA_KEY="${ROOT}/src/certs/root-ca.key"
OUT_DIR="${ROOT}/broker/certs"
mkdir -p "$OUT_DIR"

if [[ ! -f "$CA_CRT" || ! -f "$CA_KEY" ]]; then
  echo "Missing $CA_CRT or $CA_KEY — generate CA first (e.g. npm run pki:rotate or CAService)."
  exit 1
fi

openssl genrsa -out "${OUT_DIR}/broker.key" 2048

openssl req -new \
  -key "${OUT_DIR}/broker.key" \
  -out "${OUT_DIR}/broker.csr" \
  -subj "/CN=PROOF-nanomq-broker/O=Proof"

EXT="$(mktemp)"
trap 'rm -f "$EXT"' EXIT

{
  echo '[v3_req]'
  echo 'basicConstraints = CA:FALSE'
  echo 'keyUsage = digitalSignature, keyEncipherment'
  echo 'extendedKeyUsage = serverAuth'
  echo 'subjectAltName = @alt_names'
  echo '[alt_names]'
  echo 'DNS.1 = PROOF-nanomq-broker'
  echo 'DNS.2 = switchback.proxy.rlwy.net'
  echo 'DNS.3 = localhost'
} > "$EXT"

# Optional IP SANs: BROKER_SAN_IPS="1.2.3.4,5.6.7.8" or space-separated
ip_idx=1
if [[ -n "${BROKER_SAN_IPS:-}" ]]; then
  # shellcheck disable=SC2001
  _norm=$(echo "$BROKER_SAN_IPS" | tr ',' ' ')
  for _raw in $_norm; do
    _ip="${_raw//[[:space:]]/}"
    [[ -z "$_ip" ]] && continue
    echo "IP.${ip_idx} = ${_ip}" >> "$EXT"
    ip_idx=$((ip_idx + 1))
  done
fi

openssl x509 -req \
  -in "${OUT_DIR}/broker.csr" \
  -CA "$CA_CRT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -out "${OUT_DIR}/broker.crt" \
  -days 825 \
  -sha256 \
  -extfile "$EXT" \
  -extensions v3_req

echo "=== Verify leaf against same CA (expect: OK) ==="
openssl verify -CAfile "$CA_CRT" "${OUT_DIR}/broker.crt"

cat "${OUT_DIR}/broker.crt" "$CA_CRT" > "${OUT_DIR}/broker-fullchain.crt"
echo "Wrote: ${OUT_DIR}/broker.key ${OUT_DIR}/broker.crt ${OUT_DIR}/broker-fullchain.crt"
if [[ "${ip_idx}" -gt 1 ]]; then
  echo "IP SANs: ${BROKER_SAN_IPS:-}"
else
  echo "No IP SANs (set BROKER_SAN_IPS if clients connect by IP)."
fi
