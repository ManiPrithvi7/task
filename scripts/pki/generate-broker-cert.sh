#!/usr/bin/env bash
# Issue NanoMQ / MQTT broker TLS certificate (RSA) signed by the project Root CA.
#
# Prerequisites: data/ca/root-ca.crt and data/ca/root-ca.key (Proof-CA).
#   If missing, create the CA first (see comments at the bottom).
#
# Usage (from repo root):
#   ./scripts/pki/generate-broker-cert.sh
#   DATA_DIR=/path/to/data OUT_DIR=broker/certs ./scripts/pki/generate-broker-cert.sh
#
# Outputs: broker/certs/broker.key, broker/certs/broker.crt (and broker.csr for reference).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
OUT_DIR="${OUT_DIR:-$ROOT/broker/certs}"
mkdir -p "$OUT_DIR"

CA_CRT="$DATA_DIR/ca/root-ca.crt"
CA_KEY="$DATA_DIR/ca/root-ca.key"
EXT="$OUT_DIR/.broker-ext.cnf"

if [[ ! -f "$CA_CRT" || ! -f "$CA_KEY" ]]; then
  echo "Missing CA: need $CA_CRT and $CA_KEY" >&2
  exit 1
fi

echo "[pki] Generating broker key + CSR + cert (SAN: nanomq-broker, Railway proxy, localhost)..."
openssl genrsa -out "$OUT_DIR/broker.key" 2048
chmod 600 "$OUT_DIR/broker.key"

openssl req -new \
  -key "$OUT_DIR/broker.key" \
  -out "$OUT_DIR/broker.csr" \
  -subj "/CN=nanomq-broker/O=Proof"

cat >"$EXT" <<'EOF'
[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = nanomq-broker
DNS.2 = switchback.proxy.rlwy.net
DNS.3 = localhost
IP.1  = 127.0.0.1
EOF

openssl x509 -req \
  -in "$OUT_DIR/broker.csr" \
  -CA "$CA_CRT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -out "$OUT_DIR/broker.crt" \
  -days 825 \
  -sha256 \
  -extfile "$EXT" \
  -extensions v3_req

chmod 644 "$OUT_DIR/broker.crt"
rm -f "$EXT"

echo "[pki] Verifying chain..."
openssl verify -CAfile "$CA_CRT" "$OUT_DIR/broker.crt"

echo "[pki] Subject Alternative Name:"
openssl x509 -in "$OUT_DIR/broker.crt" -noout -text | grep -A4 "Subject Alternative Name" || true

echo "[pki] Done: $OUT_DIR/broker.crt + $OUT_DIR/broker.key"
echo "[pki] Update Railway NANOMQ_TLS_* with new PEMs; clients can use CN/SAN switchback.proxy.rlwy.net or MQTT_TLS_SERVERNAME=nanomq-broker."
