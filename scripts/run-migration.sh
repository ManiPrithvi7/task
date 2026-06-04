#!/bin/bash
set -e

# Full PKI migration: new Root CA + broker leaf + app client cert.
# WARNING: Rotating the Root CA requires re-provisioning all devices.

echo "Rotating Root CA and issuing new app client cert..."
npm run pki -- rotate

echo "Verifying new Root CA:"
openssl x509 -in data/ca/root-ca.crt -noout -subject -issuer

echo "Generating broker server cert..."
npm run pki:broker

echo "Success! Next steps:"
echo "  1. npm run pki:print-broker   # paste NANOMQ_TLS_* into Railway NanoMQ"
echo "  2. npm run pki -- print-app-env   # paste MQTT_TLS_* into Proof app"
echo "  3. Restart NanoMQ broker and Proof app"
