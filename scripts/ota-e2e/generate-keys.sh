#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYS_DIR="${OTA_KEYS_DIR:-$SCRIPT_DIR/keys}"
mkdir -p "$KEYS_DIR"

PRIV="$KEYS_DIR/ota_private.pem"
PUB="$KEYS_DIR/ota_public.pem"

if [[ -f "$PRIV" ]]; then
  echo "Keys already exist in $KEYS_DIR"
  exit 0
fi

openssl genpkey -algorithm ED25519 -out "$PRIV"
openssl pkey -in "$PRIV" -pubout -out "$PUB"
PUB_HEX=$(openssl pkey -in "$PRIV" -pubout -outform DER | tail -c 32 | xxd -p -c 32)

echo "Generated Ed25519 OTA keys in $KEYS_DIR"
echo "Public key hex (put in statsclient CONFIG_OTA_ED25519_PUBLIC_KEY_HEX):"
echo "  $PUB_HEX"
echo ""
echo "Do NOT commit ota_private.pem to git."
