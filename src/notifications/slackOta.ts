/**
 * OTA Slack alerts via Incoming Webhook (SLACK_OTA_WEBHOOK_URL).
 */

import { logger } from '../utils/logger';

export type SlackOtaAlertKind = 'abort' | 'advance' | 'stuck' | 'scheduler_dead';

export interface SlackOtaAlertPayload {
  kind: SlackOtaAlertKind;
  version?: string;
  percentage?: number;
  failureRate?: number;
  attempted?: number;
  failed?: number;
  rolledBack?: number;
  message?: string;
}

function dashboardLink(): string | undefined {
  const base =
    process.env.OTA_DASHBOARD_URL?.trim() ||
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.PUBLIC_BASE_URL?.trim();
  return base ? base.replace(/\/+$/, '') : undefined;
}

function formatText(payload: SlackOtaAlertPayload): string {
  const link = dashboardLink();
  const parts: string[] = [];

  switch (payload.kind) {
    case 'abort':
      parts.push(
        `*OTA ABORT* version=\`${payload.version}\` failure_rate=${payload.failureRate?.toFixed(4) ?? 'n/a'} ` +
          `failed=${payload.failed ?? 0} rolled_back=${payload.rolledBack ?? 0} attempted=${payload.attempted ?? 0}`
      );
      break;
    case 'advance':
      parts.push(
        `*OTA ADVANCE* version=\`${payload.version}\` → ${payload.percentage}%`
      );
      break;
    case 'stuck':
      parts.push(
        `*OTA STUCK* version=\`${payload.version}\` at ${payload.percentage}% — attempted=${payload.attempted ?? 0}`
      );
      break;
    case 'scheduler_dead':
      parts.push(
        `*OTA SCHEDULER DEAD* — no successful run for >15 minutes. ${payload.message || ''}`
      );
      break;
  }

  if (link) parts.push(`Dashboard: ${link}`);
  return parts.join('\n');
}

export async function sendOtaSlackAlert(payload: SlackOtaAlertPayload): Promise<boolean> {
  const url = process.env.SLACK_OTA_WEBHOOK_URL?.trim();
  if (!url) {
    logger.warn('[OTA] Slack alert skipped — SLACK_OTA_WEBHOOK_URL unset', {
      kind: payload.kind,
      version: payload.version
    });
    return false;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: formatText(payload) })
    });
    if (!res.ok) {
      logger.warn('[OTA] Slack webhook non-OK', { status: res.status, kind: payload.kind });
      return false;
    }
    return true;
  } catch (err: unknown) {
    logger.warn('[OTA] Slack webhook failed', {
      kind: payload.kind,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}
