#!/usr/bin/env bash
# Sync rotated OTA_RELEASE_WEBHOOK_SECRET from local rotate store (or .env) to Railway.
# Usage (from proofmqtt root, after `railway login` + link):
#   ./scripts/sync-ota-webhook-to-railway.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${PROOFMQTT_WEBHOOK_ROTATE_STORE:-$HOME/.config/proofmqtt-ota-webhook-rotate.env}"
export PATH="${HOME}/.railway/bin:${HOME}/bin:${PATH}"

if ! command -v railway >/dev/null; then
  echo "railway CLI not found (expected ~/.railway/bin/railway)" >&2
  exit 1
fi

if ! railway whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: railway login --browserless" >&2
  exit 1
fi

SECRET=""
if [[ -f "$STORE" ]]; then
  # shellcheck disable=SC1090
  set -a
  # Only load the new secret line
  SECRET="$(grep -E '^OTA_RELEASE_WEBHOOK_SECRET=' "$STORE" | tail -1 | cut -d= -f2-)"
  set +a
fi
if [[ -z "$SECRET" && -f "$ROOT/.env" ]]; then
  SECRET="$(grep -E '^OTA_RELEASE_WEBHOOK_SECRET=' "$ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi
if [[ -z "$SECRET" ]]; then
  echo "No OTA_RELEASE_WEBHOOK_SECRET in $STORE or $ROOT/.env" >&2
  exit 1
fi

cd "$ROOT"
railway variable set "OTA_RELEASE_WEBHOOK_SECRET=${SECRET}"
echo "Railway OTA_RELEASE_WEBHOOK_SECRET updated (length=${#SECRET}). Await redeploy, then smoke-check."
