#!/bin/bash
set -e

# Delete old CA
echo "Deleting old CA..."
rm -rf data/ca/root-ca.*

# Generate new CA
echo "Generating new PROOF-CA Root CA..."
npx ts-node generate-ca.ts

echo "Verifying new Root CA:"
openssl x509 -in data/ca/root-ca.crt -noout -subject -issuer

echo "Generating new broker CSR..."
openssl genrsa -out broker/certs/broker.key 2048

openssl req -new \
  -key broker/certs/broker.key \
  -out broker/certs/broker.csr \
  -subj "/CN=nanomq-broker/O=Proof"

echo "Creating SAN extension file..."
cat > /tmp/broker-ext.cnf << EOF
[v3_req]
subjectAltName = @alt_names
[alt_names]
DNS.1 = nanomq-broker
DNS.2 = switchback.proxy.rlwy.net
DNS.3 = localhost
IP.1  = 127.0.0.1
EOF

echo "Signing broker CSR with new PROOF-CA and SAN extensions..."
openssl x509 -req \
  -in broker/certs/broker.csr \
  -CA data/ca/root-ca.crt \
  -CAkey data/ca/root-ca.key \
  -CAcreateserial \
  -out broker/certs/broker.crt \
  -days 825 -sha256 \
  -extfile /tmp/broker-ext.cnf \
  -extensions v3_req

echo "Verifying SANs were added:"
openssl x509 -in broker/certs/broker.crt -noout -text | grep -A4 "Subject Alternative"

echo "Success! Please restart the standalone MQTT server and NanoMQ broker to apply."
