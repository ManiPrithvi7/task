import { logger } from '../utils/logger';
import { MqttClientManager } from '../servers/mqttClient';
import { DeviceService } from './deviceService';

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
    publishInterval: number = 60000  // Default: every minute
  ) {
    this.mqttClient = mqttClient;
    this.deviceService = deviceService;
    this.publishInterval = publishInterval;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Stats publisher already running');
      return;
    }

    this.isRunning = true;
    const root = this.mqttClient.getTopicRoot();
    logger.info('📈 Starting screen publisher (Instagram, GMB, POS)', {
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
      logger.info('📤 Publishing screens (instagram, gmb, pos)', { deviceCount: activeDevices.length });

      for (const device of activeDevices) {
        try {
          const current = await this.deviceService.getDevice(device.deviceId);
          if (!current || current.status !== 'active') continue;

          await this.publishInstagram(device.deviceId, root);
          await this.publishGmb(device.deviceId, root);
          await this.publishPos(device.deviceId, root);
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
