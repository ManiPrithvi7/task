# Stimulator-device OTA — firmware handoff

Lab stim OTA is hosted on **this server’s OCI bucket**. proofmqtt **generates a lab Ed25519 pair**, stores it in **Redis**, signs each uploaded `.bin` the same way CI does (`sha256sum` → sign UTF-8 hex → base64), and pushes MQTT `ota_update` on `/active` for `STIMULATE_DEVICE`.

Devices accept that signature **only** if they verify **this lab public key**. Production eFuse units will fail `signature_invalid`. USB-flash lab boards with the PEM from `GET /api/v1/admin/ota/stim/lab-public-key` first, then OTA a **newer** version.

## Device must already

- Subscribe to `{MQTT_TOPIC_ROOT}/{deviceId}/cmd` and handle `cmd: ota_update` (including `track: "pilot"` and `force: true`).
- Download `download_url` (OCI GET PAR minted at connect — not a long-lived env URL).
- Verify sha256 of bytes, Ed25519 over the UTF-8 sha256 hex string, and `size_bytes`.
- Honor `force: true`.

## Firmware team (upload)

Open the admin UI (non-production):

**`/api/v1/admin/ota/stim`**

Open in a browser (no login, non-production). Set a version newer than the device, choose the `.bin`, click Upload.

Or use HTTP:

1. Flash lab public key:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://<proofmqtt>/api/v1/admin/ota/stim/lab-public-key
```

2. Upload a single `.ino.bin` (replaces previous `firmware/stim/firmware.bin` in OCI):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -F "version=9.9.9" \
  -F "firmware=@ESP32S3_DWIN_MVP.ino.bin" \
  https://<proofmqtt>/api/v1/admin/ota/stim/firmware
```

Response: `{ version, sha256, signature, size_bytes, object_key }` (no private key). Re-upload deletes the previous object, re-hashes, re-signs, and overwrites the Redis offer.

3. Confirm offer: `GET /api/v1/admin/ota/stim/offer`

## Signing (server, same as `scripts/ci-verify.sh`)

1. SHA-256 of uploaded bytes → 64-char lowercase hex  
2. Ed25519-sign the UTF-8 bytes of that hex string  
3. Store base64 signature in Redis (`ota:stim:offer`)

Lab private PEM lives only in Redis (`ota:stim:lab_keypair`). It is **not** GitHub `OTA_ED25519_PRIVATE_KEY`. The pair is created **once**; uploads do not rotate it.

## Redis offer required

Stim OTA publishes only when Redis `ota:stim:offer` already has version, sha256, signature, size, and a URL or OCI object key (from upload). Boot does not seed from env. Missing offer → skip, no MQTT.

**Acceptance:** Allowlisted device `/active` → `ota_update` with OCI PAR + Redis sha256/signature → good sig flashes; flipped signature → `signature_invalid`.
