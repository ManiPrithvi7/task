#!/usr/bin/env bash
# Deploy broker TLS cert/key to OCI NanoMQ (Proof-v3 @ broker.withproof.io / 129.154.36.219).
#
# Prerequisites:
#   ./scripts/pki/generate-broker-cert.sh
#   OCI_API_* in .env (for default --agent mode)
#
# Usage:
#   ./scripts/pki/deploy-oci-broker-certs.sh              # OCI Instance Agent + Object Storage PAR
#   ./scripts/pki/deploy-oci-broker-certs.sh --ssh        # ssh (needs working key on Proof-v3)
#   ./scripts/pki/deploy-oci-broker-certs.sh --print-only # PEM/base64 reference only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

CRT="$ROOT/broker/certs/broker.crt"
KEY="$ROOT/broker/certs/broker.key"
ENV_FILE="${ENV_FILE:-.env}"

BROKER_HOST="${BROKER_SSH_HOST:-129.154.36.219}"
BROKER_SSH_USER="${BROKER_SSH_USER:-opc}"
BROKER_SSH_KEY="${BROKER_SSH_KEY:-$HOME/.ssh/oci_nanomq_key}"
OCI_INSTANCE_NAME="${OCI_BROKER_INSTANCE:-Proof-v3}"
OCI_REGION="${OCI_CLI_REGION:-ap-hyderabad-1}"
OCI_BUCKET="${OTA_OCI_BUCKET:-proof-firmware-ota}"
OCI_NAMESPACE="${OTA_OCI_NAMESPACE:-ax4egmknthnr}"

MODE="agent"
[[ "${1:-}" == "--ssh" ]] && MODE="ssh"
[[ "${1:-}" == "--print-only" ]] && MODE="print"

for f in "$CRT" "$KEY"; do
  [[ -f "$f" ]] || { echo "Missing $f — run ./scripts/pki/generate-broker-cert.sh first" >&2; exit 1; }
done

if [[ "$MODE" == "print" ]]; then
  echo "# Broker VM: $BROKER_HOST (OCI $OCI_INSTANCE_NAME)"
  ./scripts/pki/print-railway-broker-env.sh
  exit 0
fi

CRT_B64="$(base64 -w 0 "$CRT")"
KEY_B64="$(base64 -w 0 "$KEY")"

read -r -d '' REMOTE_SCRIPT <<SCRIPT || true
set -e
CRT_B64='${CRT_B64}'
KEY_B64='${KEY_B64}'
for d in /etc/nanomq/certs /opt/nanomq/certs /home/opc/nanomq/certs /var/lib/nanomq/certs; do
  sudo mkdir -p "\$d"
  echo "\$CRT_B64" | base64 -d | sudo tee "\$d/broker.crt" >/dev/null
  echo "\$KEY_B64" | base64 -d | sudo tee "\$d/broker.key" >/dev/null
  sudo chmod 644 "\$d/broker.crt"
  sudo chmod 600 "\$d/broker.key"
  echo "Wrote \$d/broker.crt and broker.key"
  break
done
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart nanomq 2>/dev/null || sudo systemctl restart nanomq-server 2>/dev/null || true
fi
cid=\$(sudo docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'nano|mqtt' | head -1 || true)
if [[ -n "\$cid" ]]; then
  sudo docker restart "\$cid"
  echo "Restarted docker \$cid"
fi
echo "Deploy complete"
SCRIPT

if [[ "$MODE" == "ssh" ]]; then
  [[ -f "$BROKER_SSH_KEY" ]] || { echo "SSH key not found: $BROKER_SSH_KEY" >&2; exit 1; }
  echo "[pki] Deploying via SSH to ${BROKER_SSH_USER}@${BROKER_HOST}..."
  printf '%s\n' "$REMOTE_SCRIPT" | ssh -i "$BROKER_SSH_KEY" -o StrictHostKeyChecking=no "${BROKER_SSH_USER}@${BROKER_HOST}" 'bash -s'
  echo "[pki] Verify: ./scripts/pki/verify-broker-tls.sh --host broker.withproof.io"
  exit 0
fi

export CRT KEY ENV_FILE ROOT OCI_INSTANCE_NAME OCI_REGION OCI_BUCKET OCI_NAMESPACE
python3 <<'PY'
import base64, json, os, subprocess, sys, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

root = Path(os.environ["ROOT"])
env = {}
for line in Path(os.environ["ENV_FILE"]).read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"')

for key in ("OCI_TENANCY_OCID", "OCI_USER_OCID", "OCI_FINGERPRINT", "OCI_API_PRIVATE_KEY_BASE64"):
    if key not in env:
        sys.exit(f"Missing {key} in {os.environ['ENV_FILE']}")

key_pem = base64.b64decode(env["OCI_API_PRIVATE_KEY_BASE64"]).decode()
kf = tempfile.NamedTemporaryFile("w", delete=False, suffix=".pem")
kf.write(key_pem)
kf.close()
os.chmod(kf.name, 0o600)
cfg = "/tmp/oci_broker_deploy_config"
region = os.environ.get("OCI_CLI_REGION", os.environ["OCI_REGION"])
Path(cfg).write_text(
    f"[BROKER_DEPLOY]\nuser={env['OCI_USER_OCID']}\n"
    f"fingerprint={env['OCI_FINGERPRINT']}\n"
    f"tenancy={env['OCI_TENANCY_OCID']}\nregion={region}\nkey_file={kf.name}\n"
)
os.chmod(cfg, 0o600)
oci = ["oci", "--auth", "api_key", "--profile", "BROKER_DEPLOY", "--config-file", cfg]

bucket = os.environ["OCI_BUCKET"]
namespace = os.environ["OCI_NAMESPACE"]
stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
crt_key = f"pki-temp/{stamp}/broker.crt"
key_key = f"pki-temp/{stamp}/broker.key"

for obj, path in ((crt_key, os.environ["CRT"]), (key_key, os.environ["KEY"])):
    r = subprocess.run(
        oci + ["os", "object", "put", "--bucket-name", bucket, "--namespace", namespace,
               "--name", obj, "--file", path, "--force"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"Upload failed for {obj}: {r.stderr}")

def par_url(object_name: str) -> str:
    expiry = (datetime.now(timezone.utc) + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    pr = subprocess.run(
        oci + ["os", "preauth-request", "create", "--namespace", namespace, "--bucket-name", bucket,
               "--name", f"pki-par-{stamp}-{object_name.replace('/', '-')}",
               "--object-name", object_name, "--access-type", "ObjectRead",
               "--time-expires", expiry, "--output", "json"],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(pr.stdout)["data"]
    if data.get("full-path"):
        return data["full-path"]
    token = data["access-uri"]
    return f"https://objectstorage.{region}.oraclecloud.com{token}"

crt_url = par_url(crt_key)
key_url = par_url(key_key)
print(f"[pki] Uploaded certs to oci://{namespace}/{bucket}/pki-temp/{stamp}/")

script = f"""set -e
for d in /etc/nanomq/certs /opt/nanomq/certs /home/opc/nanomq/certs /var/lib/nanomq/certs; do
  sudo mkdir -p "$d"
  curl -fsSL '{crt_url}' | sudo tee "$d/broker.crt" >/dev/null
  curl -fsSL '{key_url}' | sudo tee "$d/broker.key" >/dev/null
  sudo chmod 644 "$d/broker.crt"
  sudo chmod 600 "$d/broker.key"
  echo "Wrote $d/broker.crt and broker.key"
  break
done
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart nanomq 2>/dev/null || sudo systemctl restart nanomq-server 2>/dev/null || true
fi
cid=$(sudo docker ps --format '{{{{.Names}}}}' 2>/dev/null | grep -iE 'nano|mqtt' | head -1 || true)
if [ -n "$cid" ]; then sudo docker restart "$cid"; echo "Restarted docker $cid"; fi
echo Deploy complete
"""

lr = subprocess.run(
    oci + ["compute", "instance", "list", "--compartment-id", env["OCI_TENANCY_OCID"],
           "--display-name", os.environ["OCI_INSTANCE_NAME"], "--output", "json"],
    capture_output=True, text=True, check=True,
)
instance_id = json.loads(lr.stdout)["data"][0]["id"]
print(f"[pki] OCI instance: {os.environ['OCI_INSTANCE_NAME']} ({instance_id})")

target = json.dumps({"instanceId": instance_id})
content = json.dumps({"source": {"sourceType": "TEXT", "text": script}, "output": {"outputType": "TEXT"}})
cr = subprocess.run(
    oci + ["instance-agent", "command", "create", "--compartment-id", env["OCI_TENANCY_OCID"],
           "--target", target, "--content", content, "--timeout-in-seconds", "300", "--output", "json"],
    capture_output=True, text=True,
)
if cr.returncode != 0:
    print(cr.stderr, file=sys.stderr)
    sys.exit("OCI agent command failed. Try: ./scripts/pki/deploy-oci-broker-certs.sh --ssh")

cmd_id = json.loads(cr.stdout)["data"]["id"]
print(f"[pki] Agent command: {cmd_id}")

for _ in range(60):
    time.sleep(5)
    er = subprocess.run(
        oci + ["instance-agent", "command-execution", "list", "--instance-id", instance_id,
               "--compartment-id", env["OCI_TENANCY_OCID"], "--output", "json"],
        capture_output=True, text=True, check=True,
    )
    for ex in json.loads(er.stdout).get("data", []):
        if ex.get("instance-agent-command-id") != cmd_id:
            continue
        state = ex.get("lifecycle-state")
        print(f"[pki] Execution: {state}")
        if state in ("SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELED"):
            if ex.get("output"):
                print(ex["output"])
            if ex.get("message"):
                print(ex["message"], file=sys.stderr)
            if state != "SUCCEEDED":
                sys.exit(
                    "Deploy failed. Start Oracle Cloud Agent on Proof-v3, "
                    "or run: ./scripts/pki/deploy-oci-broker-certs.sh --ssh"
                )
            sys.exit(0)

sys.exit("Timed out (command still ACCEPTED). Start Oracle Cloud Agent on Proof-v3 or use --ssh.")
PY

echo "[pki] Verify: ./scripts/pki/verify-broker-tls.sh --host broker.withproof.io"
