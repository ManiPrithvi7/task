#!/usr/bin/env bash
# Sign firmware for ESP32 OTA E2E test.
# Device verifies Ed25519 signature over the UTF-8 SHA-256 hex digest (64 chars).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACT_DIR="${OTA_ARTIFACT_DIR:-$SCRIPT_DIR/artifacts}"
KEYS_DIR="${OTA_KEYS_DIR:-$SCRIPT_DIR/keys}"
BIN="${1:-$ARTIFACT_DIR/firmware-target.bin}"
PRIV="${OTA_PRIVATE_KEY:-$KEYS_DIR/ota_private.pem}"
VERSION="${OTA_FIRMWARE_VERSION:-4.3.1-mvp}"

if [[ ! -f "$BIN" ]]; then
  echo "Firmware not found: $BIN" >&2
  exit 1
fi
if [[ ! -f "$PRIV" ]]; then
  echo "Private key not found: $PRIV (run generate-keys.sh first)" >&2
  exit 1
fi

SHA256=$(sha256sum "$BIN" | awk '{print $1}')
SIZE=$(stat -c%s "$BIN" 2>/dev/null || stat -f%z "$BIN")

# OpenSSL 3 Ed25519 pkeyutl can fail on some builds; fall back to Node signer.
SIGNATURE=$(printf '%s' "$SHA256" | openssl pkeyutl -sign -inkey "$PRIV" -rawin 2>/dev/null | base64 -w0 || true)
if [[ -z "$SIGNATURE" ]]; then
  SIGNATURE=$(OTA_ED25519_PRIVATE_KEY_PATH="$PRIV" npx ts-node "$SCRIPT_DIR/../ota/sign-firmware.ts" --version "$VERSION" --sha256 "$SHA256" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).signature))")
fi
if [[ -z "$SIGNATURE" ]]; then
  echo "Failed to sign firmware" >&2
  exit 1
fi

PUB_HEX=$(openssl pkey -in "$PRIV" -pubout -outform DER 2>/dev/null | tail -c 32 | xxd -p -c 32 || true)
if [[ -z "$PUB_HEX" ]]; then
  PUB_HEX=$(openssl pkey -in "${OTA_KEYS_DIR:-$SCRIPT_DIR/keys}/ota_public.pem" -pubout -outform DER 2>/dev/null | tail -c 32 | xxd -p -c 32 || true)
fi

cat > "$ARTIFACT_DIR/manifest.json" <<EOF
{
  "version": "$VERSION",
  "sha256": "$SHA256",
  "signature": "$SIGNATURE",
  "size_bytes": $SIZE
}
EOF

echo "manifest.json written to $ARTIFACT_DIR/manifest.json"
echo "  version:    $VERSION"
echo "  sha256:     $SHA256"
echo "  size_bytes: $SIZE"
echo "  public_key: $PUB_HEX"
echo ""
echo "Set in statsclient sdkconfig:"
echo "  CONFIG_OTA_ED25519_PUBLIC_KEY_HEX=\"$PUB_HEX\""
