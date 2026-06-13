# ESP32 OTA End-to-End Manual Test Guide

Step-by-step guide to manually test the full OTA flow: **MQTT push → HTTP download → SHA-256 + Ed25519 verify → flash → reboot → pending-verify → `ota_success`**.

This test uses:

- **Firmware repo:** `../mqttclient` (ESP32-S3 device firmware; same project as `statsclient` on GitHub)
- **Device ID:** `DEVICE-19` (embedded mTLS cert CN: `PROOF-DEVICE-19`)
- **MQTT broker:** `mqtts://broker.withproof.io:8883` (production broker; device certs validated)
- **LAN HTTP server:** local Python server on `:8765` (simulates S3 presigned download)
- **Scripts:** `scripts/ota-e2e/`

> **Note:** The proofmqtt HTTP OTA API (`GET /api/v1/ota/check`) is optional for this test. MQTT push with a full manifest is sufficient.

---

## Architecture (what you are testing)

```
┌─────────────┐   mqtts://broker.withproof.io:8883   ┌──────────────┐
│  Your PC    │ ── publish ota_update ──────────────►│  MQTT broker │
│ (push script)│                                      └──────┬───────┘
└─────────────┘                                             │
                                                            │ proof.mqtt/DEVICE-19/cmd
                                                            ▼
┌─────────────┐   http://<LAN_IP>:8765/firmware-target.bin  ┌──────────────┐
│  Your PC    │ ◄── download ───────────────────────────────│   ESP32-S3   │
│ (HTTP srv)  │                                              │  (mqttclient)│
└─────────────┘                                              └──────────────┘
```

### MQTT topics (must match server `MQTT_TOPIC_ROOT`)

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `proof.mqtt/{deviceId}/cmd` | Server → device | `ota_update`, `ota_check` |
| `proof.mqtt/broadcast/cmd` | Server → all | Broadcast OTA commands |
| `proof.mqtt/{deviceId}/status` | Device → server | `ota_progress`, `ota_validating`, `ota_success` |
| `proof.mqtt/{deviceId}/active` | Device → server | Registration on MQTT connect |

### OTA command payload (server → device)

```json
{
  "cmd": "ota_update",
  "version": "4.3.1-mvp",
  "download_url": "http://10.151.216.236:8765/firmware-target.bin",
  "sha256": "<64-char lowercase hex>",
  "signature": "<base64 Ed25519 over sha256 hex string>",
  "size_bytes": 1124528,
  "force": true,
  "issued_at": "2026-06-13T05:43:26.969Z"
}
```

Device accepts `"cmd"` or fallback `"type"`. Use **`cmd`** in production.

---

## Prerequisites

### Hardware & host

- [ ] ESP32-S3 on USB (default serial: `/dev/ttyACM0`)
- [ ] PC and ESP32 on the **same WiFi network** (same hotspot/LAN — critical for HTTP download)
- [ ] Linux with: `python3`, `node`, `npm`, `openssl`, `sha256sum`
- [ ] User in **`dialout`** group for serial access:
  ```bash
  sudo usermod -aG dialout $USER
  # then log out/in, or use: sg dialout -c "bash -lc '...'"
  ```

### Repos & tools

- [ ] **proofmqtt** cloned and `npm install` done
- [ ] **mqttclient** cloned with ESP-IDF installed (`idf.py` works)
- [ ] Device mTLS certs embedded in `mqttclient/main/mtls_client/certs/primary/`:
  ```bash
  mkdir -p ../mqttclient/main/mtls_client/certs/primary
  cp ../statsclient/src/certs/primary/client.crt ../mqttclient/main/mtls_client/certs/primary/
  cp ../statsclient/src/certs/primary/client.key ../mqttclient/main/mtls_client/certs/primary/
  # Verify CN:
  openssl x509 -in ../mqttclient/main/mtls_client/certs/primary/client.crt -noout -subject
  # Expected: subject=CN = PROOF-DEVICE-19
  ```

### Device firmware config (mqttclient)

Baseline firmware on the device should be **older** than the OTA target (e.g. `4.3.0-mvp` → `4.3.1-mvp`).

Set in `mqttclient/sdkconfig.defaults` and `mqttclient/sdkconfig` (or `idf.py menuconfig`):

| Setting | Example value |
|---------|---------------|
| `CONFIG_FIRMWARE_VERSION` | `4.3.0-mvp` (baseline on device) |
| `CONFIG_MQTT_BROKER_URI` | `mqtts://broker.withproof.io:8883` |
| `CONFIG_MQTT_TOPIC_ROOT` | `proof.mqtt` |
| `CONFIG_MTLS_CLIENT_DEVICE_ID` | `DEVICE-19` (must match cert CN) |
| `CONFIG_USE_EMBEDDED_MTLS_CERTS` | `y` |
| `CONFIG_MQTT_SUBSCRIBE_ALL` | `y` |
| `CONFIG_OTA_ED25519_PUBLIC_KEY_HEX` | 64-char hex from `generate-keys.sh` |
| `CONFIG_DEV_WIFI_SSID` | Your WiFi/hotspot SSID (bypasses AP provisioning) |
| `CONFIG_DEV_WIFI_PASSWORD` | Your WiFi/hotspot password |
| `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` | `y` |

**WiFi bypass (dev/E2E):** When `CONFIG_DEV_WIFI_SSID` is set, firmware writes those credentials to NVS on every boot and skips the AP provisioning flow. Example:

```
CONFIG_DEV_WIFI_SSID="OPPO F31 Pro+ 5G A674"
CONFIG_DEV_WIFI_PASSWORD="ncbx8825"
```

> ESP32 only supports **2.4 GHz**. If a phone hotspot is 5 GHz-only, WiFi will never connect.

**MQTT push credentials:** The push script auto-detects device certs from `../mqttclient/main/mtls_client/certs/` and connects to `broker.withproof.io:8883`. It uses a **unique client ID** (`ota-e2e-pusher-<timestamp>`) so it does not kick the ESP32 offline. You do **not** need working `MQTT_TLS_*` entries in proofmqtt `.env` for this test.

---

## Step 1 — Generate OTA signing keys (once)

From **proofmqtt root**:

```bash
chmod +x scripts/ota-e2e/*.sh
./scripts/ota-e2e/generate-keys.sh
```

Copy the printed **public key hex** into mqttclient:

```
CONFIG_OTA_ED25519_PUBLIC_KEY_HEX="<64-char-hex>"
```

Then reconfigure:

```bash
cd ../mqttclient
idf.py reconfigure
```

> Keys are stored in `scripts/ota-e2e/keys/` (gitignored). Never commit `ota_private.pem`.

---

## Step 2 — Build and flash baseline firmware (4.3.0-mvp)

Ensure `CONFIG_FIRMWARE_VERSION="4.3.0-mvp"` in sdkconfig, then build:

```bash
cd ../mqttclient
idf.py build
```

Flash and monitor (Linux — use `bash -lc` inside `sg dialout`; `source` does not work in `/bin/sh`):

```bash
sg dialout -c "bash -lc 'source ~/.local/share/Trash/files/statsclient/esp-idf/export.sh && cd ~/Desktop/mqttclient && idf.py -p /dev/ttyACM0 flash monitor'"
```

> Adjust the `source .../export.sh` path if ESP-IDF is installed elsewhere.

**Before flashing:** stop any existing monitor on `/dev/ttyACM0` (`Ctrl+]` in that terminal), or:

```bash
fuser -k /dev/ttyACM0
```

**Success indicators in serial log:**

- `Dev WiFi override: SSID=... (skips AP provisioning)`
- `WiFi connected with OPPO F31 Pro+ 5G A674` (or your SSID)
- `MQTT_EVENT_CONNECTED — mTLS handshake successful (client_id=DEVICE-19)`
- `subscribe proof.mqtt/DEVICE-19/#: OK`
- `subscribe proof.mqtt/broadcast/cmd: OK`
- `ota_signing: OTA signing public key loaded`

Leave monitor running through the OTA test (do not flash again in another terminal while monitor is open).

---

## Step 3 — Build OTA target firmware (4.3.1-mvp)

Change version in sdkconfig, rebuild, copy binary:

```bash
cd ../mqttclient
# menuconfig or edit sdkconfig: CONFIG_FIRMWARE_VERSION="4.3.1-mvp"
idf.py build
mkdir -p ../proofmqtt/scripts/ota-e2e/artifacts
cp build/wifi_ap_project.bin ../proofmqtt/scripts/ota-e2e/artifacts/firmware-target.bin
```

> **Important:** Set `CONFIG_FIRMWARE_VERSION="4.3.1-mvp"` so post-reboot `/active` shows `"appVersion":"4.3.1-mvp"` instead of `81a0174-dirty` (ESP-IDF git describe default).

---

## Step 4 — Sign firmware and create manifest

From **proofmqtt root**:

```bash
export OTA_FIRMWARE_VERSION=4.3.1-mvp
./scripts/ota-e2e/sign-firmware.sh
```

Produces `scripts/ota-e2e/artifacts/manifest.json` with `version`, `sha256`, `signature`, `size_bytes`.

> `sign-firmware.sh` falls back to Node (`scripts/ota/sign-firmware.ts`) if OpenSSL Ed25519 signing fails.

Verify key match:

```bash
grep OTA_ED25519 ../mqttclient/sdkconfig
```

---

## Step 5 — Start LAN firmware HTTP server

**Terminal 2** (proofmqtt root):

```bash
export OTA_FIRMWARE_VERSION=4.3.1-mvp
python3 scripts/ota-e2e/firmware_server.py
```

Expected:

```
Serving .../scripts/ota-e2e/artifacts on 0.0.0.0:8765
  file=firmware-target.bin  X-Firmware-Version=4.3.1-mvp
```

Sanity check:

```bash
curl -sI http://127.0.0.1:8765/firmware-target.bin | grep -i x-firmware-version
```

**Find your LAN IP** — PC must be on the **same network as the ESP32**:

```bash
ip -4 -o addr show scope global | awk '{print $4}'
# Example on phone hotspot: 10.151.216.236/24
# Example on home WiFi:       192.168.1.42/24
```

Use the **IPv4 address only** (no `/24` suffix) as `LAN_IP`. Do **not** paste placeholder text like `<your-laptop-ip>` — bash treats `<` as redirection.

---

## Step 6 — Serial monitor (device-side trace)

**Terminal 1** should already be running `idf.py monitor` from Step 2.

Optional filtered view (second terminal):

```bash
sg dialout -c "bash -lc 'source .../export.sh && cd ~/Desktop/mqttclient && idf.py -p /dev/ttyACM0 monitor'" 2>&1 \
  | grep --line-buffered -E '\[OTA |ota_handler|ota_signing|MQTT_EVENT_CONNECTED|pending OTA|subscribe proof'
```

---

## Step 7 — Publish OTA command over MQTT

**Terminal 3** (proofmqtt root) — only after device shows MQTT connected:

```bash
cd ~/Desktop/proofmqtt
LAN_IP=10.151.216.236   # REPLACE with your real IP from Step 5
MQTT_BROKER=broker.withproof.io MQTT_PORT=8883 \
  NODE_PATH="$(pwd)/node_modules" \
  node scripts/ota-e2e/push-ota-on-active.js "$LAN_IP" DEVICE-19
```

Or use the helper script:

```bash
LAN_IP=10.151.216.236 MQTT_BROKER=broker.withproof.io MQTT_PORT=8883 \
  bash scripts/ota-e2e/run-e2e.sh DEVICE-19
```

**Healthy push script output:**

```
MQTT connected, watching proof.mqtt/DEVICE-19/active
on-connect: publish #1 → proof.mqtt/DEVICE-19/cmd OK
OTA STATUS {"type":"ota_progress","version":"4.3.1-mvp","percent":0}
OTA STATUS {"type":"ota_validating","version":"4.3.1-mvp"}
saw active on proof.mqtt/DEVICE-19/active
OTA STATUS {"type":"ota_success","version":"4.3.1-mvp"}
done
```

---

## Step 8 — Device console playbook (10-phase OTA trace)

Firmware logs `[OTA 1/10]` … `[OTA 10/10]` in `mqttclient/main/ota_handler.c`.

| Phase | Device serial (approx) | Push script |
|-------|------------------------|-------------|
| **1 — Cmd RX** | `[OTA 1/10] MQTT cmd received on proof.mqtt/DEVICE-19/cmd` | — |
| **2 — Queued** | `[OTA 2/10] Queued ota_update version=4.3.1-mvp force=1` | — |
| **3 — Partition** | `[OTA 3/10] Target partition=ota_1 size=2031616` | — |
| **4 — HTTP start** | `[OTA 4/10] HTTP GET http://<LAN_IP>:8765/firmware-target.bin` | — |
| **5 — Header gate** | `[OTA 5/10] Header OK: X-Firmware-Version=4.3.1-mvp` | — |
| **6 — Download** | `[OTA 6/10] Downloaded ... (25/50/75/100%)` | `ota_progress` |
| **7 — Crypto verify** | `[OTA 7/10] SHA-256 match OK` + `Firmware signature verified` | — |
| **8 — Flash** | `[OTA 8/10] Flash complete, setting boot partition=ota_1` | — |
| **9 — Reboot** | `[OTA 9/10] Rebooting for pending-verify...` | — |
| **10 — Verify** | `Booted with pending OTA verify...` → `[OTA 10/10] Pending verify succeeded` | `ota_validating` → `ota_success` |

During pending-verify, a second `ota_update` is correctly **ignored**:

```
W ota_handler: OTA update ignored — pending verify active
```

---

## Step 9 — Post-OTA verification checklist

After reboot, confirm:

- [ ] Device reconnects to WiFi and MQTT
- [ ] `/active` shows `"appVersion":"4.3.1-mvp"` (not `81a0174-dirty`)
- [ ] Boot partition switched: `Loaded app from partition at offset 0x210000` (`ota_1`)
- [ ] No repeated failed OTA attempts (retained cmd cleared)
- [ ] Push script printed `ota_success` with matching version

---

## Troubleshooting

### Serial port / flash

| Symptom | Fix |
|---------|-----|
| `/dev/ttyACM0` not readable | `sudo usermod -aG dialout $USER`, then `newgrp dialout` or `sg dialout -c "bash -lc '...'"` |
| `sh: source: not found` | Use `sg dialout -c "bash -lc 'source ...'"` not plain `sg dialout -c 'source ...'` |
| Port busy / could not exclusively lock | Stop monitor (`Ctrl+]`) or `fuser -k /dev/ttyACM0` before flash |

### WiFi

| Symptom | Fix |
|---------|-----|
| Stuck on `WIFI_CONNECTING` | Wrong SSID/password; set `CONFIG_DEV_WIFI_*` and reflash |
| Never connects on phone hotspot | Enable **2.4 GHz** on hotspot; ESP32 does not support 5 GHz-only |
| Old SSID still used | Dev WiFi override rewrites NVS when `CONFIG_DEV_WIFI_SSID` is set — reflash latest build |

### MQTT push

| Symptom | Fix |
|---------|-----|
| `bash: syntax error near unexpected token 'newline'` | You pasted `<your-laptop-ip>` literally — use a real IP: `LAN_IP=10.151.216.236` |
| Reconnect loop, no `saw active` | Flash device first; ensure push client ID ≠ `DEVICE-19` (fixed in script) |
| `unknown ca` with `.env` server certs | Use device certs (auto-detected) + `MQTT_BROKER=broker.withproof.io MQTT_PORT=8883` |
| Publish OK but device silent | Device not online; wait for MQTT connected in serial monitor |

### OTA download / verify

| Symptom | Fix |
|---------|-----|
| Download timeout | Same WiFi/hotspot; correct `LAN_IP`; allow TCP 8765 in firewall |
| Header version mismatch | `OTA_FIRMWARE_VERSION=4.3.1-mvp` on server and in `sign-firmware.sh` |
| SHA-256 mismatch | Rebuild target `.bin` and re-run `sign-firmware.sh` |
| `Ed25519 signature verification failed` | Public key in sdkconfig ≠ key from `generate-keys.sh` |
| `ota_success` shows `81a0174-dirty` | Rebuild target with `CONFIG_FIRMWARE_VERSION="4.3.1-mvp"` |
| Second `ota_update` during reboot | Expected — ignored during pending-verify |

### HTTP server

| Symptom | Fix |
|---------|-----|
| `Address already in use` on `:8765` | Server already running — verify with `curl -sI http://127.0.0.1:8765/firmware-target.bin` |

---

## Quick reference (3 terminals)

```bash
# Terminal 1 — flash + monitor (keep open)
sg dialout -c "bash -lc 'source <IDF_PATH>/export.sh && cd ~/Desktop/mqttclient && idf.py -p /dev/ttyACM0 flash monitor'"

# Terminal 2 — HTTP server
cd ~/Desktop/proofmqtt
export OTA_FIRMWARE_VERSION=4.3.1-mvp
python3 scripts/ota-e2e/firmware_server.py

# Terminal 3 — MQTT push (after device MQTT connected)
cd ~/Desktop/proofmqtt
LAN_IP=$(ip -4 -o addr show scope global | awk '!/docker|br-/ {print $4}' | cut -d/ -f1 | head -1)
MQTT_BROKER=broker.withproof.io MQTT_PORT=8883 \
  bash scripts/ota-e2e/run-e2e.sh DEVICE-19
```

Full rebuild path (baseline → target → sign → test):

```bash
# 1. Keys (once)
cd ~/Desktop/proofmqtt && ./scripts/ota-e2e/generate-keys.sh

# 2. Baseline build + flash
cd ~/Desktop/mqttclient
# CONFIG_FIRMWARE_VERSION="4.3.0-mvp" in sdkconfig
idf.py build
sg dialout -c "bash -lc 'source <IDF_PATH>/export.sh && idf.py -p /dev/ttyACM0 flash'"

# 3. Target build
# CONFIG_FIRMWARE_VERSION="4.3.1-mvp" in sdkconfig
idf.py build
cp build/wifi_ap_project.bin ../proofmqtt/scripts/ota-e2e/artifacts/firmware-target.bin

# 4. Sign
cd ../proofmqtt
export OTA_FIRMWARE_VERSION=4.3.1-mvp
./scripts/ota-e2e/sign-firmware.sh

# 5. Test (T2 + T3 as above)
```

---

## Files in this repo

| Path | Purpose |
|------|---------|
| `OTA_E2E_TEST.md` | This guide |
| `scripts/ota-e2e/generate-keys.sh` | Create Ed25519 keypair |
| `scripts/ota-e2e/sign-firmware.sh` | SHA-256 + sign → `manifest.json` (Node fallback) |
| `scripts/ota-e2e/firmware_server.py` | LAN HTTP server with `X-Firmware-Version` |
| `scripts/ota-e2e/push-ota-on-active.js` | MQTT publish synced to `/active` (device certs) |
| `scripts/ota-e2e/run-e2e.sh` | Start HTTP server + push (validates `LAN_IP`) |
| `scripts/ota-e2e/flash-baseline.sh` | Flash baseline with dialout check |
| `scripts/ota-e2e/artifacts/` | `firmware-baseline.bin`, `firmware-target.bin`, `manifest.json` |
| `scripts/ota-e2e/keys/` | `ota_private.pem`, `ota_public.pem` (gitignored) |

---

## Related docs

- ESP32 firmware OTA implementation: `../mqttclient/main/ota_handler.c`
- MQTT topic wiring: `../mqttclient/main/mqtt_handler.c`
- WiFi dev bypass: `../mqttclient/main/wifi_provisioning.c`
- Server OTA contract (when deployed): `docs/Proof Display OTA .md`

---

## Production OCI flow (server + Oracle Object Storage)

Use this path when proofmqtt has `OTA_ENABLED=true` and OCI credentials configured. The device must have **unrestricted outbound HTTPS** to `objectstorage.*.oraclecloud.com` (mobile hotspot works; corporate firewalls may block).

### Server prerequisites

```bash
OTA_ENABLED=true
OTA_OCI_NAMESPACE=<namespace>
OTA_OCI_BUCKET=<bucket>
OTA_OCI_REGION=ap-hyderabad-1
OCI_CONFIG_FILE=~/.oci/config
OTA_ED25519_PUBLIC_KEY_PATH=/path/to/ota_public.pem
```

### Production commands

```bash
# 1. Sign firmware (base64 signature)
sha256=$(sha256sum firmware.bin | awk '{print $1}')
ts-node scripts/ota/sign-firmware.ts --version 4.3.1-mvp --sha256 "$sha256"

# 2. Upload + finalize
AUTH_TOKEN=<jwt> OTA_API_BASE=https://server.withproof.io \
  ts-node scripts/ota/upload-release.ts \
  --file firmware.bin --version 4.3.1-mvp --sha256 "$sha256" --signature "<base64>"

# 3. Confirm signing (after first successful device OTA) OR set OTA_SIGNING_CONFIRMED=true
curl -X POST "$API/api/v1/admin/ota/signing-confirm" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirmed":true,"notes":"DEVICE-19 OCI E2E passed"}'

# 4. Promote to stable
curl -X POST "$API/api/v1/admin/ota/releases/4.3.1-mvp/promote" \
  -H "Authorization: Bearer $AUTH_TOKEN"

# 5. Push to device
AUTH_TOKEN=<jwt> ts-node scripts/ota/push-update.ts --device DEVICE-19 --version 4.3.1-mvp
```

### Production verification checklist

**Server:** init returns PAR URL; finalize rejects bad signature; promote blocked until signing confirmed; `/ota/check` returns OCI `download_url`.

**Device serial:** `[OTA 4/10]` hits `objectstorage.*.oraclecloud.com`; `[OTA 5/10]` header OK; `[OTA 7/10]` SHA-256 + Ed25519; `[OTA 10/10]` pending verify succeeded; `/active` shows new `appVersion`.

**Telemetry:** `ota_progress` → `ota_validating` → `ota_success` on `proof.mqtt/DEVICE-19/status`.

See [docs/OTA_FIRMWARE_CONTRACT.md](docs/OTA_FIRMWARE_CONTRACT.md) for full API contract.

---

## Short checklist (9 steps)

1. Generate Ed25519 OTA keys → set `CONFIG_OTA_ED25519_PUBLIC_KEY_HEX` in mqttclient
2. Copy DEVICE-19 mTLS certs into `mqttclient/main/mtls_client/certs/primary/`
3. Set WiFi (`CONFIG_DEV_WIFI_SSID` / `PASSWORD`) and broker in sdkconfig
4. Build + flash baseline (`4.3.0-mvp`) — confirm MQTT connected
5. Build target (`4.3.1-mvp`) → copy to `artifacts/firmware-target.bin`
6. Run `sign-firmware.sh` → `manifest.json`
7. Start LAN HTTP server on `:8765`
8. Keep serial monitor open; push OTA with real `LAN_IP` + `DEVICE-19`
9. Confirm `[OTA 1/10]` … `[OTA 10/10]` on serial and `ota_success` on push script
