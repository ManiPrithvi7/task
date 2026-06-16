export type OtaConfig = {
  enabled: boolean;
  presignedUrlTtlSec: number;
  downloadMode: 'proxy' | 'direct';
  signingConfirmed: boolean;
  signingPublicKeyPem?: string;
  signingPublicKeyPath?: string;
  rollbackFailureThreshold: number;
  checkRateLimitSec: number;
};