#!/bin/sh
# Railway / cloud: PEMs from env (no file mounts). Local: mount files under /etc/nanomq/certs/.
# NANOMQ_DISABLE_TLS=1 → plain MQTT on 1883 (staging only; no certs required).
set -e

CERT_DIR="/etc/nanomq/certs"
mkdir -p "$CERT_DIR"

disable_tls=false
case "${NANOMQ_DISABLE_TLS:-}" in
  1|true|TRUE|yes|YES) disable_tls=true ;;
esac

if [ "$disable_tls" = true ]; then
  echo "[nanomq] NANOMQ_DISABLE_TLS set — starting plain MQTT on 1883 (no TLS; staging only)."
  exec nanomq start --conf /etc/nanomq.plain.conf
fi

# Prefer env vars when all three are set (Railway secrets).
if [ -n "$NANOMQ_TLS_CA_CERT" ] && [ -n "$NANOMQ_TLS_CERT" ] && [ -n "$NANOMQ_TLS_KEY" ]; then
  printf '%s' "$NANOMQ_TLS_CA_CERT" > "$CERT_DIR/root_ca.crt"
  chmod 644 "$CERT_DIR/root_ca.crt"
  printf '%s' "$NANOMQ_TLS_CERT" > "$CERT_DIR/broker.crt"
  chmod 644 "$CERT_DIR/broker.crt"
  printf '%s' "$NANOMQ_TLS_KEY" > "$CERT_DIR/broker.key"
  chmod 600 "$CERT_DIR/broker.key"
  echo "[nanomq] Wrote TLS PEMs from environment variables."
elif [ -f "$CERT_DIR/root_ca.crt" ] && [ -f "$CERT_DIR/broker.crt" ] && [ -f "$CERT_DIR/broker.key" ]; then
  chmod 644 "$CERT_DIR/root_ca.crt" "$CERT_DIR/broker.crt" 2>/dev/null || true
  chmod 600 "$CERT_DIR/broker.key" 2>/dev/null || true
  echo "[nanomq] Using TLS PEM files already present under $CERT_DIR."
else
  echo "[nanomq] ERROR: Missing TLS material." >&2
  echo "  Set NANOMQ_TLS_CA_CERT, NANOMQ_TLS_CERT, NANOMQ_TLS_KEY (full PEM text), or" >&2
  echo "  mount root_ca.crt, broker.crt, broker.key under $CERT_DIR." >&2
  echo "  For staging without mTLS, set NANOMQ_DISABLE_TLS=1 (plain MQTT on 1883)." >&2
  exit 1
fi

exec nanomq start --conf /etc/nanomq.conf
