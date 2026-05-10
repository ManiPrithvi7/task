import { logger } from '../utils/logger';
import { MqttClientManager } from '../servers/mqttClient';
import { DeviceService, getActiveDeviceCache, ActiveDevice } from './deviceService';
import { CAService } from './caService';
import { Ad, AdStatus, AdType } from '../models/Ad';
import mongoose from 'mongoose';
import {
  buildScreenEnvelope,
  gmbReviewMetrics,
  instagramFollowerMetrics
} from './screenEnvelope';

/**
 * Canonical PROOF Display v6 GMB payloads for `.../test-gmb` — cycles normal → mini → mega.
 * Field values match MQTT Payload Reference examples.
 */
const TEST_GMB_V6_VARIANTS = [
  {
    label: 'v6_normal' as const,
    muted: 'false' as const,
    celebration: 'false' as const,
    payload: {
      qrText: 'https://g.page/r/...',
      verifiedReview: 42,
      rating: 4,
      nextGoal: 45,
      remainingGoal: 3,
      progress: 84,
      reviews: [
        { id: 1, googleReview: 'Best latte in Portland.', rating: '4' },
        { id: 2, googleReview: 'Amazing pastries.', rating: '5' },
        { id: 3, googleReview: 'Staff always friendly.', rating: '4' }
      ]
    }
  },
  {
    label: 'v6_mini' as const,
    muted: 'false' as const,
    celebration: 'true' as const,
    payload: {
      celebration_type: 'mini',
      qrText: 'https://g.page/r/...',
      verifiedReview: 50,
      rating: 4,
      nextGoal: 50,
      remainingGoal: 0,
      progress: 100,
      reviews: [
        { id: 1, googleReview: 'Best latte in Portland.', rating: '4' },
        { id: 2, googleReview: 'Amazing pastries.', rating: '5' },
        { id: 3, googleReview: 'Staff always friendly.', rating: '4' }
      ]
    }
  },
  {
    label: 'v6_mega' as const,
    muted: 'false' as const,
    celebration: 'true' as const,
    payload: {
      celebration_type: 'mega',
      qrText: 'https://g.page/r/...',
      verifiedReview: 100,
      rating: 4,
      nextGoal: 100,
      remainingGoal: 0,
      progress: 100,
      reviews: [
        { id: 1, googleReview: 'Best latte in Portland.', rating: '5' },
        { id: 2, googleReview: 'Amazing pastries.', rating: '5' },
        { id: 3, googleReview: 'Staff always friendly.', rating: '5' }
      ]
    }
  }
];

/** Per-device state for Instagram, GMB, POS (for mock rotation). */
interface DeviceScreenState {
  instagram: { followers: number; target: number };
  gmb: { reviews: number; rating: number };
  /** testGmbCycle: index into TEST_GMB_V6_VARIANTS for /test-gmb only */
  gmbTest: { testGmbCycle: number };
  pos: { customersToday: number };
}
export class StatsPublisher {
  private mqttClient: MqttClientManager;
  private deviceService: DeviceService;
  private publishInterval: number;
  private caService?: CAService;
  private enforceProvisioning: boolean;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private deviceState: Map<string, DeviceScreenState> = new Map();
  private lastCleanupTime: number = Date.now();

  constructor(
    mqttClient: MqttClientManager,
    deviceService: DeviceService,
    publishInterval: number = 60000, // Default: every minute
    caService?: CAService,
    enforceProvisioning: boolean = true
  ) {
    this.mqttClient = mqttClient;
    this.deviceService = deviceService;
    this.publishInterval = publishInterval;
    this.caService = caService;
    this.enforceProvisioning = enforceProvisioning;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Stats publisher already running');
      return;
    }

    this.isRunning = true;
    const root = this.mqttClient.getTopicRoot();
    logger.info('📈 Starting screen publisher (Instagram, GMB, POS, Promotion)', {
      interval: `${this.publishInterval / 1000}s`,
      topicRoot: root
    });

    await this.publishAllScreens();

    this.intervalTimer = setInterval(async () => {
      await this.publishAllScreens();
    }, this.publishInterval);
  }

  async stop(): Promise<void> {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.isRunning = false;
    logger.info('Screen publisher stopped');
  }

  private getTopicRoot(): string {
    return this.mqttClient.getTopicRoot();
  }

  private async publishAllScreens(): Promise<void> {
    try {
      await this.cleanupInactiveDeviceState();

      // Read active devices from Redis (zero MongoDB queries)
      const cache = getActiveDeviceCache();
      const activeDevices = await cache.getAllActive();

      if (activeDevices.length === 0) {
        logger.debug('📤 [PUBLISH_CYCLE] No active devices in Redis cache — skipping publish');
        return;
      }

      const root = this.getTopicRoot();
      logger.info('📤 [PUBLISH_CYCLE] Starting publish cycle', {
        deviceCount: activeDevices.length,
        source: 'redis',
        devices: activeDevices.map(d => ({
          id: d.deviceId,
          userId: d.userId || '(none)',
          adMgmt: d.adManagementEnabled,
          brand: d.brandCanvasEnabled,
          lastSeen: new Date(d.lastSeen).toISOString()
        }))
      });

      for (const device of activeDevices) {
        try {
          // Always publish test-gmb to every active device in Redis
          // (independent of device status/provisioning gates used for other screens).
          try {
            await this.publishTestGmb(device.deviceId, root);
          } catch (err: unknown) {
            logger.warn('Failed to publish test GMB screen', {
              deviceId: device.deviceId,
              error: err instanceof Error ? err.message : String(err)
            });
          }

          const current = await this.deviceService.getDevice(device.deviceId);
          if (!current || current.status !== 'active') continue;

          // Enforce device CN/provisioning before publishing (optional in testing mode)
          if (this.enforceProvisioning && this.caService) {
            try {
              const cert = await this.caService.findActiveCertificateByDeviceId(device.deviceId);
              const expectedCN = (this.caService as any).formatExpectedCN(device.deviceId);
              if (!cert || cert.cn !== expectedCN) {
                logger.warn('Skipping publish to unprovisioned device', { deviceId: device.deviceId, expectedCN, certCN: cert?.cn });
                continue;
              }
            } catch (err: any) {
              logger.warn('Error checking provisioning for device before publish; skipping', { deviceId: device.deviceId, error: err?.message ?? String(err) });
              continue;
            }
          }

          logger.debug('📤 [PUBLISH_CYCLE] Publishing all screens to device', { deviceId: device.deviceId });
          // Instagram: real follower data is published only by InstagramPoller → publishInstagramScreenIfChanged
          // (Graph API). Mock publishes here would overwrite live metrics every publishInterval.
          if (process.env.STATS_PUBLISHER_MOCK_INSTAGRAM === 'true') {
            await this.publishInstagram(device.deviceId, root);
          }
          await this.publishGmb(device.deviceId, root);
          await this.publishPos(device.deviceId, root);
          await this.publishPromotion(device, root);
        } catch (err: unknown) {
          logger.error('Failed to publish screens for device', {
            deviceId: device.deviceId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    } catch (err: unknown) {
      logger.error('Error in screen publisher', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private ensureDeviceState(deviceId: string): DeviceScreenState {
    if (!this.deviceState.has(deviceId)) {
      this.deviceState.set(deviceId, {
        instagram: { followers: 7500 + Math.floor(Math.random() * 500), target: 10000 },
        gmb: { reviews: 370 + Math.floor(Math.random() * 30), rating: 4.8 },
        gmbTest: { testGmbCycle: 0 },
        pos: { customersToday: 130 + Math.floor(Math.random() * 40) }
      });
    }
    const s = this.deviceState.get(deviceId)!;
    if (typeof s.gmbTest.testGmbCycle !== 'number') {
      s.gmbTest.testGmbCycle = 0;
    }
    return s;
  }

  /**
   * Instagram: mock publish for demos only (`STATS_PUBLISHER_MOCK_INSTAGRAM=true`).
   * Production uses `InstagramPoller` → Graph API → `publishInstagramScreenIfChanged`.
   */
  private async publishInstagram(deviceId: string, root: string): Promise<void> {
    const state = this.ensureDeviceState(deviceId);
    state.instagram.followers += 50 + Math.floor(Math.random() * 100);
    const followers = state.instagram.followers;
    const { nextGoal, remainingGoal, progress } = instagramFollowerMetrics(followers);
    const envelope = buildScreenEnvelope(
      'instagram',
      {
        followers,
        nextGoal,
        remainingGoal,
        progress,
        qrText: 'https://ig.com/handle'
      },
      { muted: 'true' }
    );

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/instagram`,
      payload: JSON.stringify(envelope),
      qos: 1,
      retain: false
    });
    logger.debug('Published Instagram screen', { deviceId, followers, nextGoal, progress });
  }

  /** Google My Business: reviews progress or celebratory milestone. */
 
  private async publishGmb(deviceId: string, root: string): Promise<void> {
    const state = this.ensureDeviceState(deviceId);
    state.gmb.reviews += 5 + Math.floor(Math.random() * 15);
    const reviews = state.gmb.reviews;
    state.gmb.rating = Math.max(1, Math.min(5, state.gmb.rating + (Math.random() * 0.2 - 0.1)));

    const { nextGoal, remainingGoal, progress } = gmbReviewMetrics(reviews);
    const ratingInt = Math.round(Math.max(1, Math.min(5, state.gmb.rating)));

    const envelope = buildScreenEnvelope(
      'gmb',
      {
        qrText: 'https://g.page/r/...',
        verifiedReview: reviews,
        rating: ratingInt,
        remainingGoal,
        nextGoal,
        progress,
        reviews: [
          { id: 1, googleReview: 'Best latte in Portland.', rating: '4' },
          { id: 2, googleReview: 'Amazing pastries and welcoming staff.', rating: '4' },
          { id: 3, googleReview: 'Coffee always hot, staff always friendly.', rating: '5' }
        ]
      },
      { muted: 'true' }
    );

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/gmb`,
      payload: JSON.stringify(envelope),
      qos: 1,
      retain: false
    });
    logger.debug('Published GMB screen', { deviceId, reviews, milestone:nextGoal });
  }

  /** POS: screen_update with must_try, customers_today, provider (square/shopify). */
  private async publishPos(deviceId: string, root: string): Promise<void> {
    const state = this.ensureDeviceState(deviceId);
    state.pos.customersToday += 3 + Math.floor(Math.random() * 10);
    const providers = ['square', 'shopify'] as const;
    const provider = providers[Math.floor(Math.random() * providers.length)];

    const envelope = buildScreenEnvelope('pos', {
      platform: provider,
      orderCount: state.pos.customersToday,
      top_seller: 'Caramel Latte'
    });

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/pos`,
      payload: JSON.stringify(envelope),
      qos: 1,
      retain: false
    });
    logger.debug('Published POS screen', { deviceId, provider, customersToday: state.pos.customersToday });
  }

  /**
   * Canvas/Promotion screen — reads preferences from Redis cache (zero MongoDB for prefs).
   * Fetches the latest RUNNING ad for this user from MongoDB (1 query, no type filter).
   * Shapes the payload based on the cached preference:
   *
   * - adManagementEnabled = true  → Promotion canvas (template data + provider + claim URL)
   * - brandCanvasEnabled  = true  → Brand canvas (template data only, no provider/url)
   * - Both false                  → Default empty canvas
   *
   * Phase 1: Always fetch latest RUNNING ad. Type-specific filtering deferred to future phase.
   */
  private async publishPromotion(device: ActiveDevice, root: string): Promise<void> {
    const { deviceId, userId, adManagementEnabled, brandCanvasEnabled } = device;

    try {
      if (!userId) {
        logger.info('🎨 [PROMOTION] No userId in cache — sending default canvas', { deviceId });
        await this.publishDefaultCanvas(deviceId, root);
        return;
      }

      // Determine canvas mode: only one pref enabled at a time, or both disabled
      let canvasMode: 'PROMOTION' | 'BRAND' | 'DEFAULT';
      if (adManagementEnabled) {
        canvasMode = 'PROMOTION';
      } else if (brandCanvasEnabled) {
        canvasMode = 'BRAND';
      } else {
        canvasMode = 'DEFAULT';
      }

      logger.info('🎨 [PROMOTION] Resolving canvas', {
        deviceId,
        userId,
        adManagementEnabled,
        brandCanvasEnabled,
        canvasMode
      });

      // Both prefs disabled → default empty canvas
      if (canvasMode === 'DEFAULT') {
        await this.publishDefaultCanvas(deviceId, root);
        return;
      }

      // Fetch the latest RUNNING ad matching the canvas mode
      const userOid = new mongoose.Types.ObjectId(userId);
      const adType = canvasMode === 'PROMOTION' ? AdType.PROMOTION : AdType.BRAND_CANVAS;
      const ad = await Ad.findOne({
        userId: userOid,
        type: adType,
        status: AdStatus.RUNNING
      }).sort({ createdAt: -1 });

      if (!ad) {
        logger.info('🎨 [PROMOTION:AD_QUERY] No RUNNING ad found for user — sending default canvas', {
          deviceId,
          userId,
          canvasMode
        });
        await this.publishDefaultCanvas(deviceId, root);
        return;
      }

      logger.info('🎨 [PROMOTION:AD_FOUND] Ad resolved from MongoDB', {
        deviceId,
        adId: ad._id.toString(),
        adName: ad.name,
        adType: ad.type,
        adStatus: ad.status,
        hasCampaign: !!ad.campaignId,
        hasTemplateData: !!ad.templateData,
        canvasMode
      });

      // Build inner payload from ad templateData
      const tplData = (ad.templateData || {}) as Record<string, any>;

      const innerPayload: Record<string, any> = {
        ...(tplData.imageTemplateId && { imageTemplateId: tplData.imageTemplateId }),
        ...(tplData.textTemplateId && { textTemplateId: tplData.textTemplateId }),
        ...(tplData.textContent && { textContent: tplData.textContent }),
        ...(tplData.textColors && { textColors: tplData.textColors })
      };

      // PROMOTION: include provider + claim URL
      // BRAND: template data only — no provider, no url
      if (canvasMode === 'PROMOTION') {
        if (tplData.provider) {
          innerPayload.provider = tplData.provider;
        }
        if (ad.campaignId) {
          innerPayload.url = `https://statsnapp.vercel.app/claim/${ad.campaignId.toString()}`;
        } else if (tplData.url) {
          innerPayload.url = tplData.url;
        }
      }

      const envelope = buildScreenEnvelope('promotion', {
        platform: (innerPayload.provider ?? tplData.provider ?? 'shopify') as string,
        Offer: (tplData.Offer ?? tplData.offer ?? '20%') as string,
        message: (tplData.message ?? tplData.textContent ?? 'Cold Brew') as string,
        qrText: (tplData.qrText ?? innerPayload.url ?? tplData.url ?? 'https://promo.link/coldbrew') as string
      });

      const topic = `${root}/${deviceId}/promotion`;
      await this.mqttClient.publish({ topic, payload: JSON.stringify(envelope), qos: 1, retain: false });

      logger.info(`🎨 [${canvasMode}:PUBLISHED] Canvas sent`, {
        deviceId,
        topic,
        adId: ad._id.toString(),
        adName: ad.name,
        canvasMode,
        payloadKeys: Object.keys(innerPayload)
      });
    } catch (err: unknown) {
      logger.error('Failed to publish promotion screen', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      try {
        await this.publishDefaultCanvas(deviceId, root);
      } catch (_) { /* swallow nested error */ }
    }
  }

  /** 4.3 Default canvas — both prefs disabled or no ad found */
  private async publishDefaultCanvas(deviceId: string, root: string): Promise<void> {
    const envelope = buildScreenEnvelope('promotion', {
      platform: 'shopify',
      Offer: '20%',
      message: 'Cold Brew',
      qrText: 'https://promo.link/coldbrew'
    });

    const topic = `${root}/${deviceId}/promotion`;
    await this.mqttClient.publish({ topic, payload: JSON.stringify(envelope), qos: 1, retain: false });
    logger.info('🎨 [DEFAULT:PUBLISHED] Empty default canvas sent', { deviceId, topic });

  }

  private async publishTestGmb(deviceId: string, root: string): Promise<void> {
    const state = this.ensureDeviceState(deviceId);
    const idx = state.gmbTest.testGmbCycle % TEST_GMB_V6_VARIANTS.length;
    const variant = TEST_GMB_V6_VARIANTS[idx];

    const envelope = buildScreenEnvelope('gmb', variant.payload, {
      muted: variant.muted,
      celebration: variant.celebration
    });

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/test-gmb`,
      payload: JSON.stringify(envelope),
      qos: 1,
      retain: false
    });

    state.gmbTest.testGmbCycle += 1;

    logger.info('Published test GMB screen', {
      deviceId,
      testGmbVariant: variant.label,
      cycle: state.gmbTest.testGmbCycle
    });
  }

  private async cleanupInactiveDeviceState(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanupTime < 60000) return;
    this.lastCleanupTime = now;

    // Use Redis active cache as source of truth for active devices
    const cache = getActiveDeviceCache();
    const activeDevices = await cache.getAllActive();
    const activeIds = new Set(activeDevices.map(d => d.deviceId));

    let removed = 0;
    for (const deviceId of this.deviceState.keys()) {
      if (!activeIds.has(deviceId)) {
        this.deviceState.delete(deviceId);
        removed++;
      }
    }
    if (removed > 0) logger.debug('Cleaned up inactive device screen state', { removed, remaining: this.deviceState.size });
  }
}
