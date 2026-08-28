import { envInt, envString } from './envHelpers';

export interface LoyaltyConfig {
  ttlMs: number;
  sessionTtlMs: number;
  ackTimeoutMs: number;
  createdSupersedeMs: number;
  commandTtlMs: number;
  spinSecret: string;
  previewOriginPattern: string;
}

export function loadLoyaltyConfig(): LoyaltyConfig {
  return {
    ttlMs: envInt('LOYALTY_TTL_MS', 5000),
    sessionTtlMs: envInt('LOYALTY_SESSION_TTL_MS', 45_000),
    ackTimeoutMs: envInt('LOYALTY_ACK_TIMEOUT_MS', 5000),
    createdSupersedeMs: envInt('LOYALTY_CREATED_SUPERSEDE_MS', 10_000),
    commandTtlMs: envInt('LOYALTY_COMMAND_TTL_MS', 10_000),
    spinSecret: envString('LOYALTY_SPIN_SECRET', ''),
    previewOriginPattern: envString('LOYALTY_PREVIEW_ORIGIN_PATTERN', '')
  };
}

export function loyaltySecretRequired(env: string): boolean {
  return env === 'production' || env === 'staging';
}
