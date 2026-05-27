/**
 * One-shot GMB Pub/Sub audience verification smoke test.
 *
 * Usage:
 *
 *   # 1. Print the exact audience this server will require:
 *   WEBHOOK_PUBLIC_BASE_URL=https://your-host.example.com \
 *     npx ts-node --transpile-only scripts/verify-gmb-audience.ts
 *
 *   # 2. Obtain a Google ID token scoped to that audience (needs gcloud CLI):
 *   AUDIENCE=$(WEBHOOK_PUBLIC_BASE_URL=https://your-host.example.com \
 *     npx ts-node --transpile-only scripts/verify-gmb-audience.ts 2>/dev/null)
 *   TOKEN=$(gcloud auth print-identity-token --audiences="$AUDIENCE")
 *
 *   # 3. Run the full verification flow against that token:
 *   AUTH_HEADER="Bearer $TOKEN" WEBHOOK_PUBLIC_BASE_URL=https://your-host.example.com \
 *     npx ts-node --transpile-only scripts/verify-gmb-audience.ts --verify
 *
 * Success output: { valid: true, payload: { email: '...', sub: '...' } }
 * Failure output: { valid: false, error: 'Wrong recipient ...' } → exit code 1
 */

import { loadWebhookConfig } from '../src/config/webhookConfig';

const GMB_WEBHOOK_PATH = '/api/webhooks/google-business-reviews';

function computeAudience(): string | null {
  const cfg = loadWebhookConfig();
  return cfg.gmbPubsubAudience ?? null;
}

async function main() {
  const audience = computeAudience();

  if (!audience) {
    console.error(
      'ERROR: Could not compute GMB audience.\n' +
      'Set WEBHOOK_PUBLIC_BASE_URL (or NEXT_PUBLIC_MQTT_PUBLIC_URL / NEXT_PUBLIC_APP_URL) and retry.'
    );
    process.exit(1);
  }

  const shouldVerify = process.argv.includes('--verify');

  if (!shouldVerify) {
    // Print the audience so callers can capture it with $()
    console.log(audience);
    return;
  }

  // Lazy-import so the audience-print path works without google-auth-library
  const { verifyPubSubPushRequest } = await import('../src/webhooks/verify/pubsubGmb');
  const cfg = loadWebhookConfig();

  const authHeader = process.env.AUTH_HEADER ?? null;
  if (!authHeader) {
    console.error(
      'ERROR: AUTH_HEADER env var required for --verify mode.\n' +
      'Example: AUTH_HEADER="Bearer <id-token>" ... npx ts-node --transpile-only scripts/verify-gmb-audience.ts --verify'
    );
    process.exit(1);
  }

  console.error('Verifying against audience:', audience);
  const result = await verifyPubSubPushRequest(
    authHeader,
    {
      audience,
      serviceAccountEmail: cfg.gmbPubsubServiceAccountEmail,
      skipAuthVerify: false
    },
    true
  );

  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
