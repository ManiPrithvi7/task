#!/bin/bash
set -e

# Full PKI migration: new Root CA + broker leaf + app client cert.
# WARNING: Rotating the Root CA requires re-provisioning all devices.

echo "Rotating Root CA and issuing new app client cert..."
bun scripts/pki/pki.ts rotate

echo "Verifying new Root CA:"
openssl x509 -in data/ca/root-ca.crt -noout -subject -issuer

echo "Generating broker server cert..."
./scripts/pki/generate-broker-cert.sh

echo "Success! Next steps:"
echo "  1. ./scripts/pki/print-railway-broker-env.sh   # paste NANOMQ_TLS_* into Railway NanoMQ"
echo "  2. bun scripts/pki/pki.ts print-app-env         # paste MQTT_TLS_* into Proof app"
echo "  3. Restart NanoMQ broker and Proof app"
