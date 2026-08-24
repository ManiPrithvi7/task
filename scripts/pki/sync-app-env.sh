#!/usr/bin/env bash
# Sync MQTT_TLS_*_BASE64 lines in .env from local PKI (data/ca + data/mqtt-client).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="${1:-.env}"

TMP="$(mktemp)"
bun scripts/pki/pki.ts print-app-env 2>/dev/null | grep '^MQTT_TLS_' > "$TMP"

python3 - "$ENV_FILE" "$TMP" <<'PY'
import re, sys
from pathlib import Path

env_path = Path(sys.argv[1])
updates = {}
for line in Path(sys.argv[2]).read_text().splitlines():
    if '=' in line:
        k, v = line.split('=', 1)
        updates[k] = v

text = env_path.read_text()
for key, val in updates.items():
    pattern = rf'^{re.escape(key)}=.*$'
    replacement = f'{key}={val}'
    if re.search(pattern, text, re.M):
        text = re.sub(pattern, replacement, text, count=1, flags=re.M)
        print(f'updated {key}')
    else:
        text += f'\n{replacement}\n'
        print(f'appended {key}')
env_path.write_text(text)
PY

rm -f "$TMP"
echo "[pki] Synced $ENV_FILE from local PKI"
