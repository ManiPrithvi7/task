#!/usr/bin/env bash
# Verify MQTT broker TLS: openssl s_client against host:port with CA from file or .env.
#
# Usage:
#   ./scripts/pki/verify-broker-tls.sh --host broker.withproof.io --port 12359 --servername nanomq-broker
#   ./scripts/pki/verify-broker-tls.sh --compare-both --port 12359 --servername nanomq-broker
#   ./scripts/pki/verify-broker-tls.sh --host broker.withproof.io --ca-file data/ca/root-ca.crt
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

HOST=""
PORT="8883"
SERVERNAME="nanomq-broker"
CA_FILE=""
ENV_FILE="${ENV_FILE:-.env}"
COMPARE_BOTH=false

usage() {
  sed -n '2,8p' "$0" | tail -n +2
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --servername) SERVERNAME="$2"; shift 2 ;;
    --ca-file) CA_FILE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --compare-both) COMPARE_BOTH=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

resolve_ca_file() {
  if [[ -n "$CA_FILE" ]]; then
    [[ -f "$CA_FILE" ]] || { echo "CA file not found: $CA_FILE" >&2; exit 1; }
    echo "$CA_FILE"
    return
  fi
  if [[ -f data/ca/root-ca.crt ]]; then
    echo "data/ca/root-ca.crt"
    return
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "No --ca-file, data/ca/root-ca.crt, or $ENV_FILE" >&2
    exit 1
  fi
  local tmp
  tmp="$(mktemp)"
  python3 - "$ENV_FILE" "$tmp" << 'PY'
import re, base64, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
m = re.search(r'^MQTT_TLS_CA_BASE64=(.+)$', text, re.M)
if not m:
    sys.exit('MQTT_TLS_CA_BASE64 not found in ' + sys.argv[1])
v = m.group(1).strip().strip('"').strip("'")
pem = base64.b64decode(v).decode('utf-8')
Path(sys.argv[2]).write_text(pem if pem.endswith('\n') else pem + '\n')
PY
  echo "$tmp"
}

verify_one() {
  local h="$1"
  local ca="$2"
  echo "=== TLS check: ${h}:${PORT} SNI=${SERVERNAME} ==="
  local out
  out="$(echo | openssl s_client -connect "${h}:${PORT}" -servername "$SERVERNAME" -CAfile "$ca" 2>&1)" || true
  echo "$out" | grep -E 'subject=|issuer=|Verify return code|Protocol|Cipher' || true
  if echo "$out" | grep -q 'Verify return code: 0 (ok)'; then
    echo "PASS: ${h}:${PORT}"
    return 0
  fi
  echo "FAIL: certificate verification failed for ${h}" >&2
  echo "$out" | grep 'Verify return code' >&2 || echo "$out" | tail -8 >&2
  return 1
}

CA="$(resolve_ca_file)"
TMP_CA=false
[[ "$CA" == /tmp/* ]] && TMP_CA=true
trap '[[ "$TMP_CA" == true ]] && rm -f "$CA"' EXIT

fail=0
if [[ "$COMPARE_BOTH" == true ]]; then
  verify_one "broker.withproof.io" "$CA" || fail=1
  echo ""
  verify_one "switchback.proxy.rlwy.net" "$CA" || fail=1
elif [[ -z "$HOST" ]]; then
  echo "--host required unless --compare-both" >&2
  usage 1
else
  verify_one "$HOST" "$CA" || fail=1
fi

exit "$fail"
