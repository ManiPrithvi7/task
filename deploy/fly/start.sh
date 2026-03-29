#!/bin/sh
set -e

CA_DIR="/data/ca"
MQTT_DATA="/data/mosquitto"

mkdir -p "$CA_DIR" "$MQTT_DATA"
chown -R mosquitto:mosquitto "$MQTT_DATA" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Signal handling: forward TERM/INT to both child processes
# ---------------------------------------------------------------------------
MOSQUITTO_PID=""
NODE_PID=""

cleanup() {
  echo "[boot] Shutting down..."
  kill "$MOSQUITTO_PID" "$NODE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

# ===========================================================================
# Phase 1 — Provisioning Root CA  (signs device certificates)
# CAService will load this on startup rather than regenerating.
# ===========================================================================
if [ ! -f "$CA_DIR/root-ca.crt" ] || [ ! -f "$CA_DIR/root-ca.key" ]; then
  echo "[boot] Generating provisioning Root CA (first run)..."
  openssl req -new -x509 -days 3650 \
    -keyout "$CA_DIR/root-ca.key" \
    -out    "$CA_DIR/root-ca.crt" \
    -nodes \
    -subj "/CN=StatsMQTT Lite Root CA/O=StatsMQTT Lite/OU=Certificate Authority/C=US" 2>/dev/null
  chmod 644 "$CA_DIR/root-ca.crt"
  chmod 600 "$CA_DIR/root-ca.key"
  echo "[boot] Root CA created"
fi

# ===========================================================================
# Phase 2 — Broker CA + Mosquitto server certificate
# Broker CA is separate from Root CA so firmware trusts the server cert
# independently from the device cert chain.
# ===========================================================================
if [ ! -f "$CA_DIR/mosquitto-server.crt" ]; then
  echo "[boot] Generating Mosquitto server TLS certificate..."

  # 2a. Broker CA (signs the server cert; firmware bundles broker-ca.crt)
  if [ ! -f "$CA_DIR/broker-ca.crt" ]; then
    openssl req -new -x509 -days 3650 \
      -keyout "$CA_DIR/broker-ca.key" \
      -out    "$CA_DIR/broker-ca.crt" \
      -nodes \
      -subj "/CN=Proof MQTT Broker CA/O=ProofMQTT/C=US" 2>/dev/null
    echo "[boot]   Broker CA created"
  fi

  # 2b. Server key
  HOSTNAME="${FLY_APP_NAME:-proof-mqtt}.fly.dev"
  openssl genrsa -out "$CA_DIR/mosquitto-server.key" 2048 2>/dev/null

  # 2c. CSR with SAN (hostname + localhost)
  cat > /tmp/san.cnf <<SANEOF
[req]
distinguished_name = req_dn
req_extensions     = v3_req
prompt             = no

[req_dn]
CN = ${HOSTNAME}
O  = ProofMQTT
C  = US

[v3_req]
subjectAltName = DNS:${HOSTNAME},DNS:localhost,IP:127.0.0.1
SANEOF

  openssl req -new \
    -key    "$CA_DIR/mosquitto-server.key" \
    -out    /tmp/server.csr \
    -config /tmp/san.cnf 2>/dev/null

  # 2d. Sign with Broker CA
  openssl x509 -req -in /tmp/server.csr \
    -CA        "$CA_DIR/broker-ca.crt" \
    -CAkey     "$CA_DIR/broker-ca.key" \
    -CAcreateserial \
    -out       "$CA_DIR/mosquitto-server.crt" \
    -days      3650 \
    -extensions v3_req \
    -extfile    /tmp/san.cnf 2>/dev/null

  rm -f /tmp/server.csr /tmp/san.cnf

  chmod 644 "$CA_DIR/mosquitto-server.crt" "$CA_DIR/broker-ca.crt"
  chmod 600 "$CA_DIR/mosquitto-server.key"
  [ -f "$CA_DIR/broker-ca.key" ] && chmod 600 "$CA_DIR/broker-ca.key"

  echo "[boot]   Server cert generated for ${HOSTNAME}"
fi

# Mosquitto runs as 'mosquitto' user; grant read access to certs
chown mosquitto:mosquitto "$CA_DIR/mosquitto-server.key" 2>/dev/null || chmod 644 "$CA_DIR/mosquitto-server.key"
chown mosquitto:mosquitto "$CA_DIR/mosquitto-server.crt" 2>/dev/null || true
chown mosquitto:mosquitto "$CA_DIR/root-ca.crt" 2>/dev/null || true

echo "[boot] Certificate summary:"
echo "  Provisioning Root CA : $CA_DIR/root-ca.crt   (signs device certs)"
echo "  Broker CA            : $CA_DIR/broker-ca.crt  (signs server cert; firmware trusts this)"
echo "  Server cert          : $CA_DIR/mosquitto-server.crt"

# ===========================================================================
# Phase 2b — Mosquitto client-cert trust bundle (fixes TLS alert unknown_ca)
#
# Devices may be signed by a *different* StatsMQTT root than the one in this
# volume (e.g. laptop CAService vs first-boot Docker root — same CN, different key).
# If extra-device-ca.crt exists (PEM), it is concatenated after root-ca.crt so
# Mosquitto accepts both issuers. Copy your firmware trust root here, e.g.:
#   cp path/to/root_certifacite.txt $CA_DIR/extra-device-ca.crt
# ===========================================================================
CLIENT_TRUST="$CA_DIR/mosquitto-client-trust.pem"
{
  cat "$CA_DIR/root-ca.crt"
  if [ -f "$CA_DIR/extra-device-ca.crt" ]; then
    echo "[boot] Mosquitto client trust: appending extra-device-ca.crt (legacy / second issuer)"
    cat "$CA_DIR/extra-device-ca.crt"
  fi
} > "${CLIENT_TRUST}.tmp"
mv "${CLIENT_TRUST}.tmp" "$CLIENT_TRUST"
chmod 644 "$CLIENT_TRUST"
chown mosquitto:mosquitto "$CLIENT_TRUST" 2>/dev/null || true

# ===========================================================================
# Phase 3 — Start Mosquitto
# ===========================================================================
echo "[boot] Starting Mosquitto on :8883 (TLS+X.509) and :1883 (internal)..."
mosquitto -c /mosquitto/config/mosquitto.conf &
MOSQUITTO_PID=$!

sleep 1
if ! kill -0 "$MOSQUITTO_PID" 2>/dev/null; then
  echo "[boot] ERROR: Mosquitto failed to start"
  exit 1
fi
echo "[boot] Mosquitto running (PID $MOSQUITTO_PID)"

# ===========================================================================
# Phase 4 — Start Node.js server (connects to local Mosquitto, plain MQTT)
# ===========================================================================
echo "[boot] Starting statsmqtt server..."
export DATA_DIR="/data"
export CA_STORAGE_PATH="$CA_DIR"
export MQTT_BROKER="127.0.0.1"
export MQTT_PORT="1883"
export MQTT_TLS_ENABLED="false"

cd /app
node dist/index.js &
NODE_PID=$!
echo "[boot] Node.js running (PID $NODE_PID)"

echo "[boot] All services up."

# ===========================================================================
# Phase 5 — Watchdog: exit if either process dies
# ===========================================================================
while kill -0 "$MOSQUITTO_PID" 2>/dev/null && kill -0 "$NODE_PID" 2>/dev/null; do
  sleep 5
done

echo "[boot] A child process exited unexpectedly."
cleanup
exit 1
