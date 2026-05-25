/** statsmqtt-local types (not Statsnapp). */

export type PubSubPushVerificationResult = {
  valid: boolean;
  error?: string;
  payload?: { email?: string; sub?: string };
};

export type GmbPubsubVerifyConfig = {
  audience: string | null;
  serviceAccountEmail?: string;
  skipAuthVerify: boolean;
};
