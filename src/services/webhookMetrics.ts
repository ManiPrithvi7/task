import { logger } from '../utils/logger';

export type WebhookProvider = 'gmb';

export type WebhookLatencyStages = {
  provider: WebhookProvider;
  verifyMs: number;
  resolveMs: number;
  publishMs: number;
  totalMs: number;
  deviceId?: string;
  clientId?: string;
  topic?: string;
  dedupeKey?: string;
  dedupeHit?: boolean;
  skippedPublish?: boolean;
};

const nsToMs = (ns: bigint): number => Number(ns) / 1e6;

export class WebhookLatencyTracker {
  private readonly t0 = process.hrtime.bigint();
  private tVerifyEnd = this.t0;
  private tResolveEnd = this.t0;
  private tPublishEnd = this.t0;

  markVerified(): void {
    this.tVerifyEnd = process.hrtime.bigint();
  }

  markResolved(): void {
    this.tResolveEnd = process.hrtime.bigint();
  }

  markPublished(): void {
    this.tPublishEnd = process.hrtime.bigint();
  }

  finish(provider: WebhookProvider, extra: Omit<WebhookLatencyStages, keyof WebhookLatencyStages>): void {
    const tEnd = process.hrtime.bigint();
    const verifyMs = nsToMs(this.tVerifyEnd - this.t0);
    const resolveMs = nsToMs(this.tResolveEnd - this.tVerifyEnd);
    const publishMs = nsToMs(this.tPublishEnd - this.tResolveEnd);
    const totalMs = nsToMs(tEnd - this.t0);

    const payload: WebhookLatencyStages = {
      provider,
      verifyMs: Math.round(verifyMs * 100) / 100,
      resolveMs: Math.round(resolveMs * 100) / 100,
      publishMs: Math.round(publishMs * 100) / 100,
      totalMs: Math.round(totalMs * 100) / 100,
      ...extra
    };

    logger.info('webhook_latency', payload);
  }
}
