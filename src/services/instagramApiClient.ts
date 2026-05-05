/**
 * Instagram Graph API Client
 *
 * Fetches follower counts, impressions, reach, and profile views
 * for a linked Instagram Business / Creator account.
 *
 * Rate-limited via InstagramRateLimiter (Redis-backed).
 * Retries on transient failures with exponential back-off.
 */

import https from 'https';
import { logger } from '../utils/logger';
import { getInstagramRateLimiter } from './instagramRateLimiter';

const GRAPH_BASE = 'graph.instagram.com';
const API_VERSION = 'v22.0';

export interface InstagramAccountInfo {
    accessToken: string;
    instagramAccountId: string;  // Instagram Business/Creator Account ID
    userId: string;              // Internal user ID (for logging / InfluxDB tags)
}

export interface InstagramMetrics {
    followers_count: number;
    /** IG handle from Graph `username` field (for profile QR links on device UI). */
    username?: string;
    followers_delta_24h: number;
    impressions_day: number;
    impressions_week: number;
    reach_day: number;
    reach_week: number;
    profile_views: number;
    media_count: number;
    engagement_rate: number;
}

export interface InstagramFetchResult {
    success: boolean;
    metrics?: InstagramMetrics;
    error?: string;
    errorCode?: string | number;
    /** Present when Instagram / CDN returns HTTP 429 */
    httpStatus?: number;
    retryAfterSeconds?: number;
    apiResponseTimeMs: number;
    instagramAccountId: string;
    cacheHit: boolean;
}

/** HTTP GET — rejects with `{ httpStatus, retryAfterSeconds }` on 429; Graph errors use JSON `error`. */
function httpsGet(url: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let body = '';
            const statusCode = res.statusCode ?? 0;
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (statusCode === 429) {
                    const rawRa = res.headers['retry-after'];
                    let retryAfterSeconds = 60;
                    if (rawRa !== undefined) {
                        const n = parseInt(String(rawRa), 10);
                        if (Number.isFinite(n) && n > 0) retryAfterSeconds = n;
                    }
                    reject(Object.assign(new Error('HTTP 429 Too Many Requests'), {
                        httpStatus: 429,
                        retryAfterSeconds
                    }));
                    return;
                }

                try {
                    const parsed = JSON.parse(body) as Record<string, unknown>;
                    if (parsed.error && typeof parsed.error === 'object') {
                        const ge = parsed.error as { message?: string; code?: number; type?: string };
                        const err = Object.assign(
                            new Error(ge.message || 'Instagram API error'),
                            { code: ge.code, type: ge.type }
                        );
                        reject(err);
                        return;
                    }
                    resolve(parsed);
                } catch {
                    reject(new Error(`Failed to parse Instagram API response (${statusCode}): ${body.slice(0, 200)}`));
                }
            });
        }).on('error', reject);
    });
}

/** Fetch basic account fields (followers, media_count) */
async function fetchAccountFields(
    accountId: string,
    accessToken: string
): Promise<{ followers_count: number; media_count: number; username?: string }> {
    const url = `https://${GRAPH_BASE}/${API_VERSION}/${accountId}?fields=followers_count,media_count,username&access_token=${accessToken}`;
    const data = await httpsGet(url) as { followers_count?: number; media_count?: number; username?: string };
    return {
        followers_count: typeof data.followers_count === 'number' ? data.followers_count : 0,
        media_count: typeof data.media_count === 'number' ? data.media_count : 0,
        ...(typeof data.username === 'string' && data.username.trim()
            ? { username: data.username.trim() }
            : {})
    };
}

// NOTE: fetchInsights (day/week impressions, reach, profile_views) commented out — not needed right now.
// Only fetching followers_count for the moment.
/*
async function fetchInsights(
    accountId: string,
    accessToken: string,
    period: 'day' | 'week'
): Promise<{ impressions: number; reach: number; profile_views: number }> {
    const metrics = period === 'day'
        ? 'impressions,reach,profile_views'
        : 'impressions,reach';
    const url = `https://${GRAPH_BASE}/${API_VERSION}/${accountId}/insights?metric=${metrics}&period=${period}&access_token=${accessToken}`;

    const data = await httpsGet(url) as { data?: Array<{ name: string; values: Array<{ value: number }> }> };
    const result = { impressions: 0, reach: 0, profile_views: 0 };
    console.log({ data, result })
    if (Array.isArray(data.data)) {
        for (const metric of data.data) {
            const latestValue = metric.values?.[metric.values.length - 1]?.value ?? 0;
            if (metric.name === 'impressions') result.impressions = latestValue;
            if (metric.name === 'reach') result.reach = latestValue;
            if (metric.name === 'profile_views') result.profile_views = latestValue;
        }
    }

    return result;
}
*/

/** Exponential back-off sleep */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch all Instagram metrics for a device with rate limiting and retry.
 */
export async function fetchInstagramMetrics(
    deviceId: string,
    account: InstagramAccountInfo,
    retryCount = 0
): Promise<InstagramFetchResult> {
    const rateLimiter = getInstagramRateLimiter();
    const startTime = Date.now();

    try {
        await rateLimiter.check(deviceId);

        logger.info('📸 [INSTAGRAM] Fetching metrics', {
            deviceId,
            accountId: account.instagramAccountId,

            attempt: retryCount + 1
        });

        // Fetch account fields only (followers_count, media_count)
        const fields = await fetchAccountFields(account.instagramAccountId, account.accessToken);

        // NOTE: Day/week insights commented out — not needed right now.
        // const [dayInsights, weekInsights] = await Promise.all([
        //     fetchInsights(account.instagramAccountId, account.accessToken, 'day'),
        //     fetchInsights(account.instagramAccountId, account.accessToken, 'week')
        // ]);

        const apiResponseTimeMs = Date.now() - startTime;

        const metrics: InstagramMetrics = {
            followers_count: fields.followers_count,
            ...(fields.username ? { username: fields.username } : {}),
            followers_delta_24h: 0,       // Would need prev value from InfluxDB; defaulting to 0
            // impressions_day: dayInsights.impressions,
            impressions_day: 0,
            // impressions_week: weekInsights.impressions,
            impressions_week: 0,
            // reach_day: dayInsights.reach,
            reach_day: 0,
            // reach_week: weekInsights.reach,
            reach_week: 0,
            // profile_views: dayInsights.profile_views,
            profile_views: 0,
            media_count: fields.media_count,
            // engagement_rate: fields.followers_count > 0
            //     ? parseFloat(((dayInsights.impressions / fields.followers_count) * 100).toFixed(2))
            //     : 0
            engagement_rate: 0
        };

        logger.info('✅ [INSTAGRAM] Metrics fetched successfully', {
            deviceId,
            followers: metrics.followers_count,
            apiResponseTimeMs
        });

        return {
            success: true,
            metrics,
            apiResponseTimeMs,
            instagramAccountId: account.instagramAccountId,
            cacheHit: false
        };

    } catch (error: unknown) {
        const apiResponseTimeMs = Date.now() - startTime;
        const err = error as Error & {
            code?: string | number;
            httpStatus?: number;
            retryAfterSeconds?: number;
        };

        if (err.httpStatus === 429) {
            const retryAfterSeconds = typeof err.retryAfterSeconds === 'number' ? err.retryAfterSeconds : 60;
            logger.warn('⛔ [INSTAGRAM] HTTP 429 — opening circuit upstream', {
                deviceId,
                retryAfterSeconds,
                apiResponseTimeMs
            });
            return {
                success: false,
                error: err.message || 'HTTP 429 Too Many Requests',
                httpStatus: 429,
                retryAfterSeconds,
                apiResponseTimeMs,
                instagramAccountId: account.instagramAccountId,
                cacheHit: false
            };
        }

        const errorCode = err.code;
        const errorMsg = err.message || 'Unknown error';

        // Rate limit error from Instagram API — retry with back-off
        if ((errorCode === 4 || errorCode === 32 || errorCode === 17) && retryCount < 3) {
            const delay = Math.pow(2, retryCount) * 1000;
            logger.warn('⏳ [INSTAGRAM] Rate limited by API, retrying', {
                deviceId, retryCount, delay, errorCode
            });
            await sleep(delay);
            return fetchInstagramMetrics(deviceId, account, retryCount + 1);
        }

        logger.error('❌ [INSTAGRAM] Failed to fetch metrics', {
            deviceId, errorMsg, errorCode, retryCount, apiResponseTimeMs
        });

        return {
            success: false,
            error: errorMsg,
            errorCode,
            apiResponseTimeMs,
            instagramAccountId: account.instagramAccountId,
            cacheHit: false
        };
    }
}
