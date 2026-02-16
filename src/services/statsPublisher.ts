import { logger } from '../utils/logger';
import { MqttClientManager } from '../servers/mqttClient';
import { DeviceService } from './deviceService';
import { CAService } from './caService';
import { Device } from '../models/Device';
import { User } from '../models/User';
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

      const allDevices = await this.deviceService.getAllDevices();
      const activeDevices = Array.from(allDevices.values()).filter(d => d.status === 'active');

      if (activeDevices.length === 0) {
        logger.debug('No active devices to publish screens to', { total: allDevices.size });
        return;
      }

      const root = this.getTopicRoot();
      logger.info('📤 Publishing screens (instagram, gmb, pos, promotion)', { deviceCount: activeDevices.length });

      for (const device of activeDevices) {
        try {
          const current = await this.deviceService.getDevice(device.deviceId);
          if (!current || current.status !== 'active') continue;

          // Enforce device CN/provisioning before publishing
          if (this.caService) {
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

          await this.publishInstagram(device.deviceId, root);
          await this.publishGmb(device.deviceId, root);
          await this.publishPos(device.deviceId, root);
          await this.publishPromotion(device.deviceId, root);
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
   * Canvas/Promotion screen: payload varies based on device owner's User preferences.
   *
   * - adManagementEnabled = true  → Promotion canvas (with provider, url, campaign data from Ad model)
   * - brandCanvasEnabled  = true  → Brand canvas (image/text template only, no provider/url)
   * - Both false                  → Default empty payload (device shows its own default screen)
   *
   * Ad selection: device-specific ad first, then any user-level ad, most recent RUNNING ad wins.
   */
  private async publishPromotion(deviceId: string, root: string): Promise<void> {
    try {
      // Step 1: Look up the raw Device document to get userId
      const deviceDoc = await Device.findOne({ clientId: deviceId });
      if (!deviceDoc || !deviceDoc.userId) {
        // No owner assigned — publish default empty canvas
        await this.publishDefaultCanvas(deviceId, root);
        return;
      }

      // Step 2: Look up User preferences
      const user = await User.findById(deviceDoc.userId);
      if (!user) {
        await this.publishDefaultCanvas(deviceId, root);
        return;
      }

      const { adManagementEnabled, brandCanvasEnabled } = user;

      // Step 3: Determine which canvas type to publish
      if (adManagementEnabled) {
        await this.publishPromotionCanvas(deviceId, root, deviceDoc.userId, deviceDoc._id);
      } else if (brandCanvasEnabled) {
        await this.publishBrandCanvas(deviceId, root, deviceDoc.userId, deviceDoc._id);
      } else {
        await this.publishDefaultCanvas(deviceId, root);
      }
    } catch (err: unknown) {
      logger.error('Failed to publish promotion screen', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      // On error, still publish default so device gets something
      try {
        await this.publishDefaultCanvas(deviceId, root);
      } catch (_) { /* swallow nested error */ }
    }
  }

  /** 4.1 Promotion canvas — adManagementEnabled = true */
  private async publishPromotionCanvas(
    deviceId: string,
    root: string,
    userId: mongoose.Types.ObjectId,
    deviceObjectId: mongoose.Types.ObjectId
  ): Promise<void> {
    // Find RUNNING promotion ad: device-specific first, then any user-level ad
    let ad = await Ad.findOne({
      userId,
      deviceId: deviceObjectId,
      type: AdType.PROMOTION,
      status: AdStatus.RUNNING
    }).sort({ createdAt: -1 });

    if (!ad) {
      ad = await Ad.findOne({
        userId,
        type: AdType.PROMOTION,
        status: AdStatus.RUNNING
      }).sort({ createdAt: -1 });
    }

    if (!ad) {
      // No running promotion ad — send default
      await this.publishDefaultCanvas(deviceId, root);
      return;
    }

    // Extract template data from ad
    const tplData = (ad.templateData || {}) as Record<string, any>;

    const innerPayload: Record<string, any> = {
      ...(tplData.imageTemplateId && { imageTemplateId: tplData.imageTemplateId }),
      ...(tplData.textTemplateId && { textTemplateId: tplData.textTemplateId }),
      ...(tplData.textContent && { textContent: tplData.textContent }),
      ...(tplData.textColors && { textColors: tplData.textColors }),
      ...(tplData.provider && { provider: tplData.provider })
    };

    // Build claim URL from campaign or ad data
    if (ad.campaignId) {
      innerPayload.url = `https://statsnapp.vercel.app/claim/${ad.campaignId.toString()}`;
    } else if (tplData.url) {
      innerPayload.url = tplData.url;
    }

    const payload = {
      version: '1.1',
      id: `msg_promo_${Date.now()}`,
      type: 'screen_update',
      muted: 'true',
      screen: 'canvas',
      timestamp: new Date().toISOString(),
      payload: innerPayload
    };

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/promotion`,
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false
    });
    logger.debug('Published promotion canvas', { deviceId, adId: ad._id.toString(), hasCampaign: !!ad.campaignId });
  }

  /** 4.2 Brand canvas — brandCanvasEnabled = true */
  private async publishBrandCanvas(
    deviceId: string,
    root: string,
    userId: mongoose.Types.ObjectId,
    deviceObjectId: mongoose.Types.ObjectId
  ): Promise<void> {
    // Find RUNNING brand canvas ad: device-specific first, then user-level
    let ad = await Ad.findOne({
      userId,
      deviceId: deviceObjectId,
      type: AdType.BRAND_CANVAS,
      status: AdStatus.RUNNING
    }).sort({ createdAt: -1 });

    if (!ad) {
      ad = await Ad.findOne({
        userId,
        type: AdType.BRAND_CANVAS,
        status: AdStatus.RUNNING
      }).sort({ createdAt: -1 });
    }

    if (!ad) {
      await this.publishDefaultCanvas(deviceId, root);
      return;
    }

    const tplData = (ad.templateData || {}) as Record<string, any>;

    const innerPayload: Record<string, any> = {
      ...(tplData.imageTemplateId && { imageTemplateId: tplData.imageTemplateId }),
      ...(tplData.textTemplateId && { textTemplateId: tplData.textTemplateId }),
      ...(tplData.textContent && { textContent: tplData.textContent }),
      ...(tplData.textColors && { textColors: tplData.textColors })
    };
    // Brand canvas: no provider, no url

    const payload = {
      version: '1.1',
      id: `msg_promo_${Date.now()}`,
      type: 'screen_update',
      muted: 'true',
      screen: 'canvas',
      timestamp: new Date().toISOString(),
      payload: innerPayload
    };

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/promotion`,
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false
    });
    logger.debug('Published brand canvas', { deviceId, adId: ad._id.toString() });
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

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/promotion`,
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false
    });
    logger.debug('Published default canvas (empty)', { deviceId });
  }

  private async cleanupInactiveDeviceState(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanupTime < 60000) return;
    this.lastCleanupTime = now;

    const allDevices = await this.deviceService.getAllDevices();
    const activeIds = new Set(
      Array.from(allDevices.values()).filter(d => d.status === 'active').map(d => d.deviceId)
    );

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
