import mongoose from 'mongoose';
import { Social, Provider } from '../models/Social';
import { logger } from '../utils/logger';

export type FollowerUpdatePayload = {
  userId: string;
  socialId: string;
  followerCount: number;
  previousCount: number;
  syncedAt: string;
};

function resolveWebhookUrl(): string | null {
  const url = process.env.WEBAPP_WEBHOOK_URL?.trim();
  return url || null;
}

function resolveWebhookSecret(): string | null {
  const secret = process.env.WEBHOOK_SECRET?.trim();
  return secret || null;
}

async function resolveSocialId(
  userId: string,
  instagramAccountId: string
): Promise<string | null> {
  if (!mongoose.Types.ObjectId.isValid(userId)) return null;
  try {
    const social = await Social.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      socialAccountId: instagramAccountId,
      provider: Provider.INSTAGRAM
    })
      .select({ _id: 1 })
      .lean();
    return social ? String(social._id) : null;
  } catch (err: unknown) {
    logger.debug('[WEBAPP_WEBHOOK] Failed to resolve socialId', {
      userId,
      instagramAccountId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Fire-and-forget webhook to web app dashboard cache (change-only).
 */
export async function notifyWebappFollowerUpdate(opts: {
  userId: string;
  instagramAccountId: string;
  followerCount: number;
  previousCount: number;
  syncedAt: Date;
}): Promise<void> {
  const url = resolveWebhookUrl();
  const secret = resolveWebhookSecret();
  if (!url || !secret) {
    logger.debug('[WEBAPP_WEBHOOK] Skipped — WEBAPP_WEBHOOK_URL or WEBHOOK_SECRET not set');
    return;
  }

  if (opts.followerCount === opts.previousCount) return;

  const socialId = await resolveSocialId(opts.userId, opts.instagramAccountId);
  if (!socialId) {
    logger.warn('[WEBAPP_WEBHOOK] No Social row for follower update', {
      userId: opts.userId,
      instagramAccountId: opts.instagramAccountId
    });
    return;
  }

  const payload: FollowerUpdatePayload = {
    userId: opts.userId,
    socialId,
    followerCount: opts.followerCount,
    previousCount: opts.previousCount,
    syncedAt: opts.syncedAt.toISOString()
  };

  void (async () => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': secret
        },
        body: JSON.stringify(payload),
        signal: ac.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        logger.warn('[WEBAPP_WEBHOOK] Non-OK response', {
          status: res.status,
          userId: opts.userId,
          socialId
        });
      } else {
        logger.info('[WEBAPP_WEBHOOK] Follower update sent', {
          userId: opts.userId,
          socialId,
          followerCount: opts.followerCount,
          previousCount: opts.previousCount
        });
      }
    } catch (err: unknown) {
      logger.warn('[WEBAPP_WEBHOOK] Delivery failed', {
        userId: opts.userId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  })();
}
