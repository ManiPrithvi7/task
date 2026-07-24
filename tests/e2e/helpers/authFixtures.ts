export const TEST_ADMIN_BEARER = 'e2e-admin-bearer-token';
export const TEST_PROVISIONING_TOKEN = 'e2e-provisioning-token';
export const TEST_RECOVERY_TOKEN = 'e2e-recovery-token';
export const TEST_WEBHOOK_SECRET = 'e2e-webhook-secret';

export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
