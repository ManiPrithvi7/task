#!/usr/bin/env bash
# Issue an MQTT **client** cert (mTLS) for the backend / tests — signed by data/ca Root CA.
# Default CN: mqtt-publisher-lite (matches emit-server-mqtt-env / CAService-style naming).
#
# Usage (repo root):
#   ./scripts/pki/generate-mqtt-client-cert.sh
#   CLIENT_CN=PROOF-my-device OUT_DIR=broker/certs ./scripts/pki/generate-mqtt-client-cert.sh
#
# Outputs: $OUT_DIR/client.key, client.crt, client.csr
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
OUT_DIR="${OUT_DIR:-$ROOT/broker/certs}"
CLIENT_CN="${CLIENT_CN:-mqtt-publisher-lite}"

CA_CRT="$DATA_DIR/ca/root-ca.crt"
CA_KEY="$DATA_DIR/ca/root-ca.key"
EXT="$(mktemp)"
trap 'rm -f "$EXT"' EXIT

mkdir -p "$OUT_DIR"
if [[ ! -f "$CA_CRT" || ! -f "$CA_KEY" ]]; then
  echo "Missing CA: $CA_CRT and $CA_KEY" >&2
  exit 1
fi

cat >"$EXT" <<EOF
[v3_client]
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
subjectAltName=DNS:${CLIENT_CN}
EOF

echo "[pki] Generating MQTT client key + cert (CN=$CLIENT_CN)..."
openssl genrsa -out "$OUT_DIR/client.key" 2048
chmod 600 "$OUT_DIR/client.key"
openssl req -new -key "$OUT_DIR/client.key" -out "$OUT_DIR/client.csr" -subj "/CN=${CLIENT_CN}/O=Proof"
openssl x509 -req \
  -in "$OUT_DIR/client.csr" \
  -CA "$CA_CRT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -out "$OUT_DIR/client.crt" \
  -days 825 \
  -sha256 \
  -extfile "$EXT" \
  -extensions v3_client

chmod 644 "$OUT_DIR/client.crt"
openssl verify -CAfile "$CA_CRT" "$OUT_DIR/client.crt"
echo "[pki] Done: $OUT_DIR/client.crt + $OUT_DIR/client.key"
