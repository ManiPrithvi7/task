import { logger } from '../utils/logger';
import { MqttClientManager } from '../servers/mqttClient';
import { DeviceService, getActiveDeviceCache, ActiveDevice } from './deviceService';
import { CAService } from './caService';
import { Ad, AdStatus, AdType } from '../models/Ad';
import mongoose from 'mongoose';

/** Per-device state for Instagram, GMB, POS (for progress/celebratory rotation). */
interface DeviceScreenState {
  instagram: { followers: number; target: number };
  gmb: { reviews: number; rating: number };
  pos: { customersToday: number };
}

export class StatsPublisher {
  private mqttClient: MqttClientManager;
  private deviceService: DeviceService;
  private publishInterval: number;
  private caService?: CAService;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private deviceState: Map<string, DeviceScreenState> = new Map();
  private lastCleanupTime: number = Date.now();

  constructor(
    mqttClient: MqttClientManager,
    deviceService: DeviceService,
    publishInterval: number = 60000, // Default: every minute
    caService?: CAService
  ) {
    this.mqttClient = mqttClient;
    this.deviceService = deviceService;
    this.publishInterval = publishInterval;
    this.caService = caService;
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
          logger.debug('📤 [PUBLISH_CYCLE] Publishing all screens to device', { deviceId: device.deviceId });
          await this.publishInstagram(device.deviceId, root);
          await this.publishGmb(device.deviceId, root);
          await this.publishPos(device.deviceId, root);
          await this.publishPromotionFromCache(device, root);
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
        pos: { customersToday: 130 + Math.floor(Math.random() * 40) }
      });
    }
    return this.deviceState.get(deviceId)!;
  }

  /** Instagram: progress (progress < 100) or celebratory (progress 100). */
  private async publishInstagram(deviceId: string, root: string): Promise<void> {
    const state = this.ensureDeviceState(deviceId);
    state.instagram.followers += 50 + Math.floor(Math.random() * 100);
    const target = state.instagram.target;
    const followers = state.instagram.followers;
    const progress = Math.min(100, Math.round((followers / target) * 100));
    const isCelebratory = progress >= 100;

    const payload = {
      version: '1.1',
      id: `msg_inst_${Date.now()}`,
      screen: 'instagram',
      Muted: 'true',
      Sound: 'true',
      timestamp: new Date().toISOString(),
      payload: isCelebratory
        ? {
            followers_count: target,
            duration: 20,
            target,
            progress: 100,
            color_palette: 'instagram',
            message: "yey!, you made it!",
            animation: 'pulse_grow',
            sound: 'celebration.wav',
            url: 'https://instagram.com/businessprofile'
          }
        : {
            followers_count: followers,
            duration: 15,
            target,
            progress,
            color_palette: 'instagram',
            message: `Almost at ${Math.round(followers / 1000)}k followers!`,
            animation: 'pulse_grow',
            url: 'https://instagram.com/businessprofile'
          }
    };

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/instagram`,
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false
    });
    logger.debug('Published Instagram screen', { deviceId, progress, celebratory: isCelebratory });
  }

  /** Google My Business: reviews progress or celebratory milestone. */
  private async publishGmb(deviceId: string, root: string): Promise<void> {
    const state = this.ensureDeviceState(deviceId);
    state.gmb.reviews += 5 + Math.floor(Math.random() * 15);
    const reviews = state.gmb.reviews;
    const isMilestone = reviews % 100 === 0 || reviews === 400;

    const payload = {
      version: '1.1',
      id: `msg_gmb_${Date.now()}`,
      Muted: 'true',
      Sound: 'true',
      screen: 'gmb',
      timestamp: new Date().toISOString(),
      payload: {
        reviews_count: reviews,
        celebration_type: 'milestone',
        duration: isMilestone ? 20 : 15,
        overall_rating: state.gmb.rating,
        color_palette: 'google',
        message: isMilestone ? `you get ${reviews} impressions` : `${reviews} reviews! Help us reach 500`,
        animation: 'rating_stars',
        ...(isMilestone && { sound: 'celebration.wav' }),
        url: 'https://g.page/r/EXAMPLE/review'
      }
    };

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/gmb`,
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false
    });
    logger.debug('Published GMB screen', { deviceId, reviews, milestone: isMilestone });
  }

  /** POS: screen_update with must_try, customers_today, provider (square/shopify). */
  private async publishPos(deviceId: string, root: string): Promise<void> {
    const state = this.ensureDeviceState(deviceId);
    state.pos.customersToday += 3 + Math.floor(Math.random() * 10);
    const providers = ['square', 'shopify'] as const;
    const provider = providers[Math.floor(Math.random() * providers.length)];

    const payload = {
      version: '1.1',
      id: `msg_pos_${Date.now()}`,
      type: 'screen_update',
      muted: 'true',
      screen: 'pos',
      timestamp: new Date().toISOString(),
      payload: {
        must_try: 'Premium Coffee Blend',
        customers_today: state.pos.customersToday,
        provider
      }
    };

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/pos`,
      payload: JSON.stringify(payload),
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
  private async publishPromotionFromCache(device: ActiveDevice, root: string): Promise<void> {
    const { deviceId, userId, adManagementEnabled, brandCanvasEnabled } = device;

    try {
      if (!userId) {
        logger.info('🎨 [PROMOTION] No userId in cache — sending default canvas', { deviceId });
        await this.publishDefaultCanvas(deviceId, root);
        return;
      }

      // Neither preference enabled → default empty
      if (!adManagementEnabled && !brandCanvasEnabled) {
        logger.info('🎨 [PROMOTION] Both prefs disabled — sending default canvas', { deviceId, userId });
        await this.publishDefaultCanvas(deviceId, root);
        return;
      }

      const canvasMode = adManagementEnabled ? 'PROMOTION' : 'BRAND';
      logger.info('🎨 [PROMOTION] Resolving canvas', {
        deviceId,
        userId,
        adManagementEnabled,
        brandCanvasEnabled,
        canvasMode
      });

      // Phase 1: Fetch the latest RUNNING ad for this user (any type)
      const userOid = new mongoose.Types.ObjectId(userId);
      const ad = await Ad.findOne({
        userId: userOid,
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

      // Promotion canvas: include provider + claim URL
      if (adManagementEnabled) {
        if (tplData.provider) {
          innerPayload.provider = tplData.provider;
        }
        if (ad.campaignId) {
          innerPayload.url = `https://statsnapp.vercel.app/claim/${ad.campaignId.toString()}`;
        } else if (tplData.url) {
          innerPayload.url = tplData.url;
        }
      }
      // Brand canvas: no provider, no url (inner payload already has template data only)

      const payload = {
        version: '1.1',
        id: `msg_promo_${Date.now()}`,
        type: 'screen_update',
        muted: 'true',
        screen: 'canvas',
        timestamp: new Date().toISOString(),
        payload: innerPayload
      };

      const topic = `${root}/${deviceId}/promotion`;
      await this.mqttClient.publish({ topic, payload: JSON.stringify(payload), qos: 1, retain: false });

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
    const payload = {
      version: '1.1',
      id: `msg_promo_${Date.now()}`,
      type: 'screen_update',
      muted: 'true',
      screen: 'canvas',
      timestamp: new Date().toISOString(),
      payload: {}
    };

    const topic = `${root}/${deviceId}/promotion`;
    await this.mqttClient.publish({ topic, payload: JSON.stringify(payload), qos: 1, retain: false });
    logger.info('🎨 [DEFAULT:PUBLISHED] Empty default canvas sent', { deviceId, topic });
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
