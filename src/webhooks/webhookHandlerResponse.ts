import { Response } from 'express';
import { WebhookLatencyTracker, WebhookProvider } from '../services/webhookMetrics';
import { flushWebhookInflux } from './influxAudit';

type FinishExtra = Parameters<WebhookLatencyTracker['finish']>[1];

export async function finishWebhookAck(
  res: Response,
  platform: WebhookProvider,
  tracker: WebhookLatencyTracker,
  finishExtra: FinishExtra,
  body: Record<string, unknown> = { acknowledged: true }
): Promise<void> {
  tracker.finish(platform, finishExtra);
  await flushWebhookInflux();
  res.status(200).json(body);
}
