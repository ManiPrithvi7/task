# ESP32 OTA End-to-End Manual Test Guide

Step-by-step guide to manually test the full OTA flow: **MQTT push → HTTP download → SHA-256 + Ed25519 verify → flash → reboot → pending-verify → `ota_success`**.

This test uses:

- **Firmware repo:** `../statsclient` (ESP32-S3 device firmware)
- **Server/broker:** proofmqtt `.env` (MQTT mTLS to `broker.withproof.io`)
- **LAN HTTP server:** local Python server (simulates S3 presigned download)
- **Scripts:** `scripts/ota-e2e/`

> **Note:** The proofmqtt HTTP OTA API (`GET /api/v1/ota/check`) is optional for this test. MQTT push with a full manifest is sufficient.

---

## Architecture (what you are testing)

```
┌─────────────┐   mqtts://broker.withproof.io:8883   ┌──────────────┐
│  Your PC    │ ── publish ota_update ──────────────►│  MQTT broker │
│ (push script)│                                      └──────┬───────┘
└─────────────┘                                             │
                                                            │ proof.mqtt/DEVICE-17/cmd
                                                            ▼
┌─────────────┐   http://<LAN_IP>:8765/firmware-target.bin  ┌──────────────┐
│  Your PC    │ ◄── download ───────────────────────────────│   ESP32-S3   │
│ (HTTP srv)  │                                              │  (statsclient)│
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
  "download_url": "http://192.168.x.x:8765/firmware-target.bin",
  "sha256": "<64-char lowercase hex>",
  "signature": "<base64 Ed25519 over sha256 hex string>",
  "size_bytes": 1123664,
  "force": true,
  "issued_at": "2026-06-12T12:00:00.000Z"
}
```

Device accepts `"cmd"` or fallback `"type"`. Use **`cmd`** in production.

---

## Prerequisites

### Hardware & host

- [ ] ESP32-S3 on USB (default serial: `/dev/ttyACM0`)
- [ ] PC and ESP32 on the **same WiFi LAN**
- [ ] Linux/macOS with: `python3`, `openssl`, `sha256sum`, `node`, `npm`

### Repos & tools

- [ ] **proofmqtt** cloned and `npm install` done
- [ ] **statsclient** cloned with ESP-IDF installed (`idf.py` works)
- [ ] proofmqtt `.env` has working MQTT mTLS vars:
  - `MQTT_BROKER`, `MQTT_PORT`
  - `MQTT_TLS_CA_BASE64`, `MQTT_TLS_CLIENT_CERT_BASE64`, `MQTT_TLS_CLIENT_KEY_BASE64`
  - `MQTT_TOPIC_ROOT=proof.mqtt`

### Device firmware config (statsclient)

Baseline firmware on the device should be **older** than the OTA target (e.g. `4.3.0-mvp` → `4.3.1-mvp`).

In `statsclient/sdkconfig` (or `idf.py menuconfig` → OTA / MQTT):

| Setting | Example value |
|---------|---------------|
| `CONFIG_FIRMWARE_VERSION` | `4.3.0-mvp` (baseline on device) |
| `CONFIG_MQTT_BROKER_URI` | `mqtts://broker.withproof.io:8883` |
| `CONFIG_MQTT_TOPIC_ROOT` | `proof.mqtt` |
| `CONFIG_MTLS_CLIENT_DEVICE_ID` | `DEVICE-17` (must match cert CN) |
| `CONFIG_USE_EMBEDDED_MTLS_CERTS` | `y` |
| `CONFIG_MQTT_SUBSCRIBE_ALL` | `y` |
| `CONFIG_OTA_ED25519_PUBLIC_KEY_HEX` | 64-char hex from `generate-keys.sh` |
| `CONFIG_OTA_POLL_INTERVAL_SEC` | `60` (optional, for poll path) |

---

## Step 1 — Generate OTA signing keys (once)

From **proofmqtt root**:

```bash
chmod +x scripts/ota-e2e/*.sh
./scripts/ota-e2e/generate-keys.sh
```

Copy the printed **public key hex** into statsclient:

```
CONFIG_OTA_ED25519_PUBLIC_KEY_HEX="<64-char-hex>"
```

Reconfigure statsclient if you changed sdkconfig:

```bash
cd ../statsclient
idf.py reconfigure
```

> Keys are stored in `scripts/ota-e2e/keys/` (gitignored). Never commit `ota_private.pem`.

---

## Step 2 — Flash baseline firmware to the device

Build and flash **version A** (the version currently running before OTA):

```bash
cd ../statsclient

# Ensure CONFIG_FIRMWARE_VERSION="4.3.0-mvp" in sdkconfig
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

Confirm in serial log:

- WiFi connected
- `MQTT_EVENT_CONNECTED — mTLS handshake successful (client_id=DEVICE-17)`
- `subscribe proof.mqtt/DEVICE-17/#: OK`
- `subscribe proof.mqtt/broadcast/cmd: OK`

Press `Ctrl+]` to exit monitor (or use a second terminal for later steps).

---

## Step 3 — Build OTA target firmware (version B)

Build a **new** binary with a **higher version string**:

```bash
cd ../statsclient

# Edit sdkconfig: CONFIG_FIRMWARE_VERSION="4.3.1-mvp"
idf.py build
```

Copy the built binary into proofmqtt artifacts:

```bash
mkdir -p ../proofmqtt/scripts/ota-e2e/artifacts
cp build/wifi_ap_project.bin ../proofmqtt/scripts/ota-e2e/artifacts/firmware-target.bin
```

> **Important:** The OTA target must be built with the **correct `CONFIG_FIRMWARE_VERSION`** so post-reboot telemetry shows the expected version (not `git-dirty`).

---

## Step 4 — Sign firmware and create manifest

From **proofmqtt root**:

```bash
export OTA_FIRMWARE_VERSION=4.3.1-mvp
./scripts/ota-e2e/sign-firmware.sh
```

This writes `scripts/ota-e2e/artifacts/manifest.json` with `version`, `sha256`, `signature`, `size_bytes`.

Verify the public key in statsclient matches the key used to sign:

```bash
grep OTA_ED25519 ../statsclient/sdkconfig
```

---

## Step 5 — Start LAN firmware HTTP server

The device downloads firmware over plain HTTP from your PC. It **requires** the response header:

```
X-Firmware-Version: 4.3.1-mvp
```

From **proofmqtt root**:

```bash
export OTA_FIRMWARE_VERSION=4.3.1-mvp
python3 scripts/ota-e2e/firmware_server.py
```

Expected output:

```
Serving .../scripts/ota-e2e/artifacts on 0.0.0.0:8765
  file=firmware-target.bin  X-Firmware-Version=4.3.1-mvp
```

If port 8765 is already in use, either keep the existing server or free the port:

```bash
fuser -k 8765/tcp
```

**Find your LAN IP** (ESP32 must reach this address):

```bash
hostname -I | awk '{print $1}'
# Example: 192.168.29.95
```

Quick sanity check from your PC:

```bash
curl -sI "http://127.0.0.1:8765/firmware-target.bin" | grep -i x-firmware-version
```

---

## Step 6 — Open serial monitor

In a dedicated terminal:

```bash
cd ../statsclient
idf.py -p /dev/ttyACM0 monitor
```

Filter mentally for lines containing: `ota`, `MQTT cmd`, `download`, `signature`, `reboot`, `ota_success`.

---

## Step 7 — Publish OTA command over MQTT

From **proofmqtt root** (new terminal), publish when the device is online.
The script waits for `/active` so the command is not lost during reconnects:

```bash
LAN_IP=$(hostname -I | awk '{print $1}')
NODE_PATH="$(pwd)/node_modules" node scripts/ota-e2e/push-ota-on-active.js "$LAN_IP" DEVICE-17
```

Replace `DEVICE-17` if your device uses a different ID.

---

## Step 8 — Expected serial log sequence (success)

| Step | Log line (approx) |
|------|-------------------|
| 1 | `message topic=proof.mqtt/DEVICE-17/cmd` |
| 2 | `ota_handler: MQTT cmd on proof.mqtt/DEVICE-17/cmd: {"cmd":"ota_update"...}` |
| 3 | `Queued ota_update version=4.3.1-mvp` |
| 4 | `Starting OTA download for version 4.3.1-mvp` |
| 5 | `Firmware signature verified` |
| 6 | `OTA install complete (... bytes), rebooting...` |
| 7 | *(reboot)* `Booted with pending OTA verify for version 4.3.1-mvp` |
| 8 | `OTA pending verify succeeded for version 4.3.1-mvp` |

The push script should also print:

```
OTA STATUS {"type":"ota_progress",...}
OTA STATUS {"type":"ota_validating",...}
OTA STATUS {"type":"ota_success","version":"4.3.1-mvp"}
```

---

## Step 9 — Verify post-OTA behavior

After reboot, confirm:

- [ ] Device reconnects to MQTT
- [ ] `/active` shows `"appVersion":"4.3.1-mvp"`
- [ ] No repeated failed OTA attempts (stale retained cmd cleared)
- [ ] Running partition switched (optional): log shows boot from `ota_1` if previous was `ota_0`

---

## Troubleshooting

### MQTT cmd never arrives on device

| Symptom | Fix |
|---------|-----|
| Publish OK but no device log | Publish **after** device connects; use `push-ota-on-active.js` |
| Frequent `MQTT_EVENT_DISCONNECTED` | Normal with auto-reconnect; retry push while connected |
| Wrong device ID | Match `CONFIG_MTLS_CLIENT_DEVICE_ID` / cert CN |

### Download fails

| Symptom | Fix |
|---------|-----|
| Connection timeout | PC firewall: allow TCP 8765; same WiFi subnet |
| Header version mismatch | `OTA_FIRMWARE_VERSION` must match manifest `version` |
| SHA-256 mismatch | Re-run `sign-firmware.sh` after rebuilding `.bin` |

### Signature verification fails

| Symptom | Fix |
|---------|-----|
| `Ed25519 signature verification failed` | Public key in sdkconfig ≠ key used in `sign-firmware.sh` |
| Wrong signing payload | Device signs **UTF-8 sha256 hex string** (64 chars), not raw binary |

### `ESP_ERR_OTA_ROLLBACK_INVALID_STATE` after reboot

Retained `ota_update` replayed during pending-verify. Fixed in recent firmware (ignores OTA during verify + clears retained cmd). Reflash latest statsclient build.

### `ESP_ERR_NVS_KEY_TOO_LONG` on cooldown

Fixed: NVS key is `ota_dl_ts` (≤15 chars). Reflash if you see the old key name in logs.

### HTTP poll `/api/v1/ota/check` fails

Separate from MQTT push test. Requires:

1. Server OTA API deployed on `server.withproof.io`
2. Device flashed with TLS fix (CA bundle for server verify + device cert for client auth)

Poll failure does **not** block MQTT push OTA.

### Firmware server: `Address already in use`

An instance is already running on `:8765` — that is fine. Verify with:

```bash
curl -sI http://127.0.0.1:8765/firmware-target.bin
```

---

## Quick reference (copy-paste)

Run from **proofmqtt root** after baseline is flashed and target `.bin` is signed:

```bash
# Terminal 1 — HTTP server
export OTA_FIRMWARE_VERSION=4.3.1-mvp
python3 scripts/ota-e2e/firmware_server.py

# Terminal 2 — serial monitor
cd ../statsclient && idf.py -p /dev/ttyACM0 monitor

# Terminal 3 — MQTT push
LAN_IP=$(hostname -I | awk '{print $1}')
NODE_PATH="$(pwd)/node_modules" node scripts/ota-e2e/push-ota-on-active.js "$LAN_IP" DEVICE-17
```

Full rebuild path (baseline → target → sign → test):

```bash
# Baseline
cd ../statsclient && idf.py build flash

# Target (change CONFIG_FIRMWARE_VERSION first)
idf.py build
cp build/wifi_ap_project.bin ../proofmqtt/scripts/ota-e2e/artifacts/firmware-target.bin

# Sign + test
cd ../proofmqtt
export OTA_FIRMWARE_VERSION=4.3.1-mvp
./scripts/ota-e2e/sign-firmware.sh
python3 scripts/ota-e2e/firmware_server.py &
LAN_IP=$(hostname -I | awk '{print $1}')
NODE_PATH="$(pwd)/node_modules" node scripts/ota-e2e/push-ota-on-active.js "$LAN_IP" DEVICE-17
```

---

## Files in this repo

| Path | Purpose |
|------|---------|
| `OTA_E2E_TEST.md` | This guide |
| `scripts/ota-e2e/generate-keys.sh` | Create Ed25519 keypair |
| `scripts/ota-e2e/sign-firmware.sh` | SHA-256 + sign → `manifest.json` |
| `scripts/ota-e2e/firmware_server.py` | LAN HTTP server with `X-Firmware-Version` |
| `scripts/ota-e2e/push-ota-on-active.js` | MQTT publish synced to device `/active` |
| `scripts/ota-e2e/artifacts/` | `firmware-target.bin`, `manifest.json` (gitignored) |
| `scripts/ota-e2e/keys/` | `ota_private.pem`, `ota_public.pem` (gitignored) |

---

## Related docs

- ESP32 firmware OTA implementation: `../statsclient/main/ota_handler.c`
- MQTT topic wiring: `../statsclient/main/mqtt_handler.c`
- Server OTA contract (when deployed): `docs/Proof Display OTA .md`


the full flow in 9 steps shorter version:

Generate Ed25519 OTA keys
Flash baseline firmware (4.3.0-mvp)
Build target firmware (4.3.1-mvp)
Sign and create manifest.json
Start LAN HTTP server (:8765)
Open serial monitor
Publish ota_update via MQTT (synced to /active)
Expected success log sequence
Post-OTA verification checklist