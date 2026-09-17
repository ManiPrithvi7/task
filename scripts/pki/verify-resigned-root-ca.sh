#!/usr/bin/env bash
# Gate a re-signed Root CA before env swap. Does not rotate the CA key.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OLD="${OLD_CA:-$ROOT/data/certs/root-ca.crt}"
NEW="${NEW_CA:-$ROOT/data/certs/root-ca.resigned.crt}"
BROKER="${BROKER_CRT:-$ROOT/broker/certs/broker.crt}"
CLIENT="${CLIENT_CRT:-$ROOT/data/mqtt-client/client.crt}"

fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -f "$OLD" && -f "$NEW" ]] || fail "missing $OLD or $NEW"

echo "=== structure (AKI must be keyid-only, never 3000) ==="
if openssl asn1parse -in "$NEW" -i | grep -q 'HEX DUMP]:3000$'; then
  fail "new CA still has empty AKI SEQUENCE 3000"
fi
openssl x509 -in "$NEW" -noout -text | grep -q 'Authority Key Identifier' \
  || fail "AKI missing on re-signed root"
openssl x509 -in "$NEW" -noout -ext authorityKeyIdentifier,subjectKeyIdentifier,basicConstraints,keyUsage
AKI_KEYID="$(openssl x509 -in "$NEW" -noout -text | awk '/Authority Key Identifier/{getline; gsub(/^[ \t]+keyid:/,""); gsub(/ /,""); print; exit}')"
SKI_HEX="$(openssl x509 -in "$NEW" -noout -ext subjectKeyIdentifier | tail -n +2 | tr -d ' \n')"
[[ -n "$AKI_KEYID" && "$AKI_KEYID" == "$SKI_HEX" ]] || fail "AKI keyid ($AKI_KEYID) != SKI ($SKI_HEX)"
echo "AKI keyid == SKI: $SKI_HEX"

echo
echo "=== identity vs old ==="
echo "-- old --"
openssl x509 -in "$OLD" -noout -serial -subject -issuer
echo "-- new --"
openssl x509 -in "$NEW" -noout -serial -subject -issuer
OLD_SERIAL="$(openssl x509 -in "$OLD" -noout -serial)"
NEW_SERIAL="$(openssl x509 -in "$NEW" -noout -serial)"
OLD_SUBJ="$(openssl x509 -in "$OLD" -noout -subject)"
NEW_SUBJ="$(openssl x509 -in "$NEW" -noout -subject)"
OLD_ISSUER="$(openssl x509 -in "$OLD" -noout -issuer)"
NEW_ISSUER="$(openssl x509 -in "$NEW" -noout -issuer)"
[[ "$OLD_SERIAL" == "$NEW_SERIAL" ]] || fail "serial changed"
[[ "$OLD_SUBJ" == "$NEW_SUBJ" ]] || fail "subject changed"
[[ "$OLD_ISSUER" == "$NEW_ISSUER" ]] || fail "issuer changed"

OLD_SKI="$(openssl x509 -in "$OLD" -noout -ext subjectKeyIdentifier | tail -n +2 | tr -d ' \n')"
NEW_SKI="$(openssl x509 -in "$NEW" -noout -ext subjectKeyIdentifier | tail -n +2 | tr -d ' \n')"
[[ "$OLD_SKI" == "$NEW_SKI" ]] || fail "SKI changed: $OLD_SKI vs $NEW_SKI"
echo "SKI match: $NEW_SKI"

diff -q <(openssl x509 -in "$OLD" -noout -pubkey) <(openssl x509 -in "$NEW" -noout -pubkey) \
  || fail "public keys differ"
echo "pubkeys equal"

OLD_FP="$(openssl x509 -in "$OLD" -noout -fingerprint -sha256)"
NEW_FP="$(openssl x509 -in "$NEW" -noout -fingerprint -sha256)"
echo "$OLD_FP"
echo "$NEW_FP"
[[ "$OLD_FP" != "$NEW_FP" ]] || fail "fingerprint unchanged — TBS was not re-signed"

echo
echo "=== self-signature ==="
openssl verify -CAfile "$NEW" "$NEW" || fail "self-signature invalid"

echo
echo "=== existing leaves still chain ==="
openssl verify -CAfile "$NEW" "$BROKER" || fail "broker leaf does not verify"
[[ -f "$CLIENT" ]] && openssl verify -CAfile "$NEW" "$CLIENT"

echo
echo "=== old CA self-verify (poison encoding still OpenSSL-ok) ==="
openssl verify -CAfile "$OLD" "$OLD" >/dev/null && echo "old OpenSSL self-verify: OK (expected)"

echo
echo "ALL OPENSSL GATES PASSED: $NEW"
