import { logger } from '../utils/logger';
import { MqttClientManager } from '../servers/mqttClient';
import { DeviceService, getActiveDeviceCache, ActiveDevice } from './deviceService';
import { CAService } from './caService';
import {
  buildScreenEnvelope,
  gmbReviewMetrics,
  instagramFollowerMetrics
} from './screenEnvelope';
import { publishForce, publishIfChanged } from './mqttChangeDetection';
import {
  buildCampaignPayload,
  getEligibleCampaignsForUser,
  getNextPromotionIndex
} from './promotionService';
import { getUserIntegrations } from './userIntegrationCache';

/**
 * Canonical PROOF Display v6 GMB payloads for `.../gmb` (firmware listens here for celebration flows).
 * Cycles normal → mini → mega. `.../test-gmb` uses a separate muted progression publish — see `publishTestGmb`.
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
  /** testGmbCycle: index into TEST_GMB_V6_VARIANTS for canonical /gmb publishes (variant rotation). */
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
          lastSeen: new Date(d.lastSeen).toISOString()
        }))
      });

      for (const device of activeDevices) {
        try {
          // test-gmb: muted progression only (no celebration) — all Redis-active devices, no provisioning gate.
          // gmb: canonical v6 + celebrations — published later only for active + provisioned devices.
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
          // Production GMB/POS come from webhooks + connect pull; mocks overwrite real data every cycle.
          if (process.env.STATS_PUBLISHER_MOCK_GMB === 'true') {
            await this.publishGmb(device.deviceId, root);
          }
          if (process.env.STATS_PUBLISHER_MOCK_POS === 'true') {
            await this.publishPos(device.deviceId, root);
          }
          await this.publishPromotionForDevice(device.deviceId, root);
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

  /**
   * `.../test-gmb`: lightweight GMB-shaped screen for dev/QA (muted, no celebration envelope).
   * Firmware milestone/celebration handling is exercised on `.../gmb` via `publishGmb`.
   */
  private async publishTestGmb(deviceId: string, root: string): Promise<void> {
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
      { muted: 'true', celebration: 'false' }
    );

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/test-gmb`,
      payload: JSON.stringify(envelope),
      qos: 1,
      retain: false
    });
    logger.debug('Published test-gmb screen', { deviceId, reviews, milestone: nextGoal });
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

    const topic = `${root}/${deviceId}/pos`;
    await publishIfChanged({
      deviceId,
      topic,
      hashInput: envelope.payload,
      payload: JSON.stringify(envelope),
      mqttClient: this.mqttClient,
      qos: 1,
      retain: false
    });
    logger.debug('Published POS screen', { deviceId, provider, customersToday: state.pos.customersToday });
  }

  /**
   * Canvas/Promotion screen — reads preferences from Redis cache (zero MongoDB for prefs).
   * Used by the 60s publish cycle and connect-refresh coordinator (same hash dedupe path).
   */
  async publishPromotionForDevice(
    deviceId: string,
    root: string,
    opts?: { force?: boolean }
  ): Promise<void> {
    const cache = getActiveDeviceCache();
    const device = await cache.getActive(deviceId);
    if (!device) {
      logger.warn('[PROMOTION] Device not in active cache — skip', { deviceId, force: opts?.force === true });
      return;
    }

    const { userId } = device;

    try {
      const force = opts?.force === true;

      if (!userId) {
        await this.publishDefaultCanvas(deviceId, root, force);
        return;
      }

      const integrations = await getUserIntegrations(userId);
      if (!integrations?.pos?.platform) {
        logger.info('[PROMOTION] No POS integration — default canvas', { deviceId, userId });
        await this.publishDefaultCanvas(deviceId, root, force);
        return;
      }

      const { campaigns } = await getEligibleCampaignsForUser(userId, integrations);
      if (campaigns.length === 0) {
        logger.info('[PROMOTION] No eligible campaigns — default canvas', {
          deviceId,
          userId,
          posPlatform: integrations.pos.platform
        });
        await this.publishDefaultCanvas(deviceId, root, force);
        return;
      }

      const index = await getNextPromotionIndex(deviceId, campaigns.length);
      const campaign = campaigns[index];
      const campaignId = String((campaign as { _id: unknown })._id);
      const screenPayload = buildCampaignPayload(campaign);
      const envelope = buildScreenEnvelope('promotion', screenPayload);

      const result = await this.publishPromotionEnvelope(deviceId, root, envelope, campaignId, force);

      if (result.published) {
        logger.info('[PROMOTION] Published campaign', {
          deviceId,
          userId,
          campaignId,
          campaignName: (campaign as { name?: string }).name,
          offerCode: (campaign as { offerCode?: string }).offerCode,
          rotationIndex: index,
          totalCampaigns: campaigns.length,
          topic: `${root}/${deviceId}/promotion`,
          Offer: screenPayload.Offer,
          message: screenPayload.message,
          qrText: screenPayload.qrText
        });
      } else {
        logger.info('[PROMOTION] Skipped unchanged payload', {
          deviceId,
          campaignId,
          reason: result.reason
        });
      }
    } catch (err: unknown) {
      logger.error('Failed to publish promotion screen', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      try {
        await this.publishDefaultCanvas(deviceId, root, opts?.force === true);
      } catch (_) {
        /* swallow nested error */
      }
    }
  }

  /** 4.3 Default canvas — no POS, no eligible campaigns, or error fallback */
  private async publishDefaultCanvas(deviceId: string, root: string, force = false): Promise<void> {
    const envelope = buildScreenEnvelope('promotion', {
      platform: 'shopify',
      Offer: '20%',
      message: 'Cold Brew',
      qrText: 'https://promo.link/coldbrew'
    });

    const result = await this.publishPromotionEnvelope(deviceId, root, envelope, undefined, force);
    const topic = `${root}/${deviceId}/promotion`;
    if (result.published) {
      logger.info('🎨 [DEFAULT:PUBLISHED] Empty default canvas sent', { deviceId, topic });
    } else {
      logger.info('[PROMOTION] Default canvas not published', {
        deviceId,
        topic,
        reason: result.reason
      });
    }
  }

  /** Shared MQTT publish + payload-hash dedupe for promotion (cycle + connect pull). */
  private async publishPromotionEnvelope(
    deviceId: string,
    root: string,
    envelope: ReturnType<typeof buildScreenEnvelope>,
    campaignId?: string,
    force = false
  ): Promise<{ published: boolean; reason: 'changed' | 'unchanged' | 'no_redis' }> {
    const topic = `${root}/${deviceId}/promotion`;
    const hashInput = campaignId
      ? { ...(envelope.payload as Record<string, unknown>), campaignId }
      : envelope.payload;
    const payload = JSON.stringify(envelope);

    if (force) {
      await publishForce({
        deviceId,
        topic,
        hashInput,
        payload,
        mqttClient: this.mqttClient,
        qos: 1,
        retain: false,
        source: 'promotion_connect_force'
      });
      return { published: true, reason: 'changed' };
    }

    return publishIfChanged({
      deviceId,
      topic,
      hashInput,
      payload: JSON.stringify(envelope),
      mqttClient: this.mqttClient,
      qos: 1,
      retain: false
    });
  }

  /** `.../gmb`: canonical v6 payload rotation including mini/mega celebration envelopes. */
  private async publishGmb(deviceId: string, root: string): Promise<void> {
    const state = this.ensureDeviceState(deviceId);
    const idx = state.gmbTest.testGmbCycle % TEST_GMB_V6_VARIANTS.length;
    const variant = TEST_GMB_V6_VARIANTS[idx];

    const envelope = buildScreenEnvelope('gmb', variant.payload, {
      muted: variant.muted,
      celebration: variant.celebration
    });

    const topic = `${root}/${deviceId}/gmb`;
    await publishIfChanged({
      deviceId,
      topic,
      hashInput: envelope.payload,
      payload: JSON.stringify(envelope),
      mqttClient: this.mqttClient,
      qos: 1,
      retain: false
    });

    state.gmbTest.testGmbCycle += 1;

    logger.info('Published GMB screen (v6 variant cycle)', {
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
