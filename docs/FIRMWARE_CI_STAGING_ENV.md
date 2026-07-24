# Firmware CI — Week 1 `staging` environment

Handoff for [proof-firmware](https://github.com/statsnapptechnologies/proof-firmware) GitHub Actions. Configure under **Settings → Environments → `staging`**.

Week 1 only creates **`staging`**. Do not create `production` until Week 5.

## Decisions

| Item | Value |
|------|--------|
| `PROOFMQTT_URL` | `https://server.withproof.io` |
| OCI bucket | Reuse `proof-firmware-ota` (same as live proofmqtt) |
| Canaries | `DEVICE-13,DEVICE-15` + 1% rollout from OTA Deploy |
| Rollout advance | Hourly **OTA Auto-Advance** only |

**Why not `proof-firmware-ota-staging` yet:** CI webhooks hit live proofmqtt, which defaults to `proof-firmware-ota`. A separate staging bucket without a matching server `OTA_OCI_BUCKET` override would upload binaries devices cannot download. Split buckets with a real `staging.withproof.io` in Week 5.

## Variables

| Variable | Staging value |
|----------|----------------|
| `PROOFMQTT_URL` | `https://server.withproof.io` |
| `OTA_OCI_BUCKET` | `proof-firmware-ota` |
| `OTA_OCI_NAMESPACE` | `ax4egmknthnr` |
| `OTA_CANARY_DEVICE_IDS` | `DEVICE-13,DEVICE-15` |
| `OCI_CLI_REGION` | `ap-hyderabad-1` |

## Secrets (source map — never commit values)

| Secret | Source |
|--------|--------|
| `OCI_TENANCY_OCID` | proofmqtt `.env` `OCI_TENANCY_OCID` |
| `OCI_USER_OCID` | proofmqtt `.env` `OCI_USER_OCID` |
| `OCI_FINGERPRINT` | proofmqtt `.env` `OCI_FINGERPRINT` |
| `OCI_API_PRIVATE_KEY` | Decode `.env` `OCI_API_PRIVATE_KEY_BASE64` → PEM |
| `OTA_ED25519_PRIVATE_KEY` | PEM pairing with server verify key (`scripts/ota-e2e/keys/ota_private.pem`) |
| `OTA_ED25519_PUBLIC_KEY` | PEM / decode `OTA_ED25519_PUBLIC_KEY_BASE64` |
| `OTA_RELEASE_WEBHOOK_SECRET` | Strong shared secret; must match Railway/live proofmqtt |
| `SLACK_WEBHOOK_URL` | Slack `#ota-alerts` incoming webhook (optional until Auto-Advance alerts needed) |

Firmware CI uses `SLACK_WEBHOOK_URL`. proofmqtt app uses `SLACK_OTA_WEBHOOK_URL`. Same Slack URL may be set in both; names differ.

## Apply with `gh` (from a machine that has local secrets)

```bash
REPO=statsnapptechnologies/proof-firmware
ENV=staging

# Create environment (idempotent via API)
gh api --method PUT "repos/$REPO/environments/$ENV" --silent

# Variables
gh variable set PROOFMQTT_URL --env "$ENV" --repo "$REPO" --body "https://server.withproof.io"
gh variable set OTA_OCI_BUCKET --env "$ENV" --repo "$REPO" --body "proof-firmware-ota"
gh variable set OTA_OCI_NAMESPACE --env "$ENV" --repo "$REPO" --body "ax4egmknthnr"
gh variable set OTA_CANARY_DEVICE_IDS --env "$ENV" --repo "$REPO" --body "DEVICE-13,DEVICE-15"
gh variable set OCI_CLI_REGION --env "$ENV" --repo "$REPO" --body "ap-hyderabad-1"

# Secrets via stdin (example — use real paths/values locally)
# printf '%s' "$OCI_TENANCY_OCID" | gh secret set OCI_TENANCY_OCID --env "$ENV" --repo "$REPO"
# … same for OCI_USER_OCID, OCI_FINGERPRINT, OCI_API_PRIVATE_KEY (PEM),
# OTA_ED25519_PRIVATE_KEY, OTA_ED25519_PUBLIC_KEY, OTA_RELEASE_WEBHOOK_SECRET, SLACK_WEBHOOK_URL
```

## Rotate `OTA_RELEASE_WEBHOOK_SECRET`

Single bearer on `POST /api/webhooks/ota-release` and `POST /api/webhooks/ota-rollout-advance`. No dual-secret grace window.

1. Pause OTA Deploy / Auto-Advance.
2. Generate: `openssl rand -base64 32`
3. Set on **Railway / live proofmqtt first**, redeploy/restart.
4. Set the **same** value on GitHub `staging` → `OTA_RELEASE_WEBHOOK_SECRET` (and local `.env` / ops scripts).
5. Verify: new Bearer authorized; old Bearer → 401.
6. Resume CI.

## Branch protection (`main` on proof-firmware)

Target rules:

- Require a pull request before merging
- Require status check: job **`validate`** (workflow display name **PR Validation**)
- Do not allow bypassing (including administrators)

```bash
gh api --method PUT repos/statsnapptechnologies/proof-firmware/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["validate"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

**Note (2026-07-24):** Applying this via API returned HTTP 403 — *Upgrade to GitHub Pro or make this repository public to enable this feature.* Until the org has branch protection on private repos, enforce the same rules manually in **Settings → Branches** after upgrading, or make the repo public / move under an org plan that includes protection.

## Week 1 apply status

| Item | Status |
|------|--------|
| GitHub env `staging` + variables | Applied |
| OCI + Ed25519 + webhook secrets on `staging` | Applied (`SLACK_WEBHOOK_URL` left unset) |
| Local `.env` webhook rotated | Applied |
| Live Railway `OTA_RELEASE_WEBHOOK_SECRET` | Applied on project `awake-enchantment` / service `task` (`server.withproof.io`); smoke-checked (new Bearer → 400 missing fields; old → 401) |

## Week 5 gate

- Add GitHub environment `production` with **separate** webhook secret and OCI creds.
- Never point `production` `PROOFMQTT_URL` at prod while using the staging webhook secret.
- Introduce `staging.withproof.io` + `proof-firmware-ota-staging` together (server `OTA_OCI_BUCKET` must match).

## Related

- Firmware setup doc: `proof-firmware/docs/GITHUB_CI_SETUP.md`
- Server contract: [SERVER_OTA_REQUIREMENTS.md](./SERVER_OTA_REQUIREMENTS.md)
