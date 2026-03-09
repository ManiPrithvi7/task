import { logger } from '../utils/logger';
import { MqttClientManager } from '../servers/mqttClient';
import { DeviceService, getActiveDeviceCache, ActiveDevice } from './deviceService';
import { CAService } from './caService';
import { KafkaService } from './kafkaService';
import { Ad, AdStatus, AdType } from '../models/Ad';
import mongoose from 'mongoose';

interface DeviceScreenState {
  instagram: { followers: number; target: number };
  gmb: { reviews: number; rating: number };
  pos: { customersToday: number };
}

interface ScheduledPublish {
  deviceId: string;
  screenType: 'instagram' | 'gmb' | 'pos' | 'promotion';
  scheduledTime: number;
  priority: 'normal' | 'high';
}

export class StatsPublisher {
  private mqttClient: MqttClientManager;
  private deviceService: DeviceService;
  private caService?: CAService;
  private kafkaService?: KafkaService;

  // Scheduling configuration
  private readonly baseInterval: number = 60000; // 60 seconds base
  private readonly maxDelay: number = 30000; // 30 seconds max delay
  private readonly minDelay: number = 5000; // 5 seconds min delay
  private readonly batchSize: number = 50; // Max devices per batch

  // State management
  private deviceState: Map<string, DeviceScreenState> = new Map();
  private publishQueue: ScheduledPublish[] = [];
  private processingTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastCleanupTime: number = Date.now();

  // New device tracking
  private knownDevices: Set<string> = new Set();
  private highPriorityDevices: Set<string> = new Set();

  constructor(
    mqttClient: MqttClientManager,
    deviceService: DeviceService,
    caService?: CAService,
    kafkaService?: KafkaService
  ) {
    this.mqttClient = mqttClient;
    this.deviceService = deviceService;
    this.caService = caService;
    this.kafkaService = kafkaService;
  }

  setKafkaService(kafka: KafkaService): void {
    this.kafkaService = kafka;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Stats publisher already running');
      return;
    }

    this.isRunning = true;
    const root = this.mqttClient.getTopicRoot();
    logger.info('📈 Starting scheduled screen publisher', {
      baseInterval: `${this.baseInterval / 1000}s`,
      maxDelay: `${this.maxDelay / 1000}s`,
      batchSize: this.batchSize,
      topicRoot: root
    });

    // Initial sync of known devices
    await this.syncKnownDevices();

    // Start the processing loop
    this.startProcessingLoop();
  }

  async stop(): Promise<void> {
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
    }
    this.isRunning = false;
    this.publishQueue = [];
    logger.info('Scheduled screen publisher stopped');
  }

  private async startProcessingLoop(): Promise<void> {
    const processBatch = async () => {
      try {
        if (!this.isRunning) return;

        // Sync known devices periodically (every 30 seconds)
        if (Date.now() - this.lastCleanupTime > 30000) {
          await this.syncKnownDevices();
        }

        // Process next batch of scheduled publications
        await this.processScheduledPublishes();

        // Schedule next processing cycle
        this.scheduleNextProcessing();
      } catch (error) {
        logger.error('Error in processing loop', { error });
        this.scheduleNextProcessing(); // Continue even on error
      }
    };

    // Start first batch
    await processBatch();
  }

  private scheduleNextProcessing(): void {
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
    }

    // Calculate next processing time based on queue
    const nextProcessingDelay = this.calculateNextProcessingDelay();

    this.processingTimer = setTimeout(async () => {
      await this.processScheduledPublishes();
      this.scheduleNextProcessing();
    }, nextProcessingDelay);
  }

  private calculateNextProcessingDelay(): number {
    if (this.publishQueue.length === 0) {
      return this.baseInterval; // No items, check again in 60 seconds
    }

    const now = Date.now();
    const nextScheduledTime = Math.min(...this.publishQueue.map(p => p.scheduledTime));
    const delay = Math.max(0, nextScheduledTime - now);

    // Cap the delay between min and max
    return Math.min(this.maxDelay, Math.max(this.minDelay, delay));
  }

  private async syncKnownDevices(): Promise<void> {
    try {
      const cache = getActiveDeviceCache();
      const activeDevices = await cache.getAllActive();

      const currentDevices = new Set(activeDevices.map(d => d.deviceId));

      // Identify new devices
      const newDevices = [...currentDevices].filter(id => !this.knownDevices.has(id));

      if (newDevices.length > 0) {
        logger.info('📱 New devices detected', {
          count: newDevices.length,
          devices: newDevices
        });

        // Mark as high priority
        newDevices.forEach(id => this.highPriorityDevices.add(id));

        // Schedule immediate high-priority publishes for new devices
        await this.scheduleHighPriorityPublishes(newDevices);
      }

      // Update known devices
      this.knownDevices = currentDevices;
      this.lastCleanupTime = Date.now();

      // Clean up state for inactive devices
      await this.cleanupInactiveDeviceState(currentDevices);

    } catch (error) {
      logger.error('Failed to sync known devices', { error });
    }
  }

  private async scheduleHighPriorityDevices(devices: string[]): Promise<void> {
    const now = Date.now();

    for (const deviceId of devices) {
      // Schedule all screen types with minimal delay
      const screens: Array<'instagram' | 'gmb' | 'pos' | 'promotion'> =
        ['instagram', 'gmb', 'pos', 'promotion'];

      for (const screenType of screens) {
        this.publishQueue.push({
          deviceId,
          screenType,
          scheduledTime: now + Math.random() * 5000, // Spread within 5 seconds
          priority: 'high'
        });
      }
    }

    logger.info('🚀 Scheduled high priority publishes', {
      deviceCount: devices.length,
      totalJobs: devices.length * 4
    });
  }

  private async scheduleHighPriorityPublishes(deviceIds: string[]): Promise<void> {
    const now = Date.now();

    for (const deviceId of deviceIds) {
      // Schedule all screen types for immediate publishing
      const screens: Array<'instagram' | 'gmb' | 'pos' | 'promotion'> =
        ['instagram', 'gmb', 'pos', 'promotion'];

      for (const screenType of screens) {
        // Add slight randomization to avoid thundering herd
        this.publishQueue.push({
          deviceId,
          screenType,
          scheduledTime: now + Math.floor(Math.random() * 2000), // 0-2 second spread
          priority: 'high'
        });
      }
    }

    logger.debug('Scheduled high priority publishes', {
      deviceCount: deviceIds.length,
      jobs: deviceIds.length * 4
    });
  }

  private async processScheduledPublishes(): Promise<void> {
    const now = Date.now();

    // Sort queue by priority and scheduled time
    this.publishQueue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority === 'high' ? -1 : 1;
      }
      return a.scheduledTime - b.scheduledTime;
    });

    // Get due items (including high priority regardless of time)
    const dueItems = this.publishQueue.filter(p =>
      p.priority === 'high' || p.scheduledTime <= now
    );

    if (dueItems.length === 0) {
      return;
    }

    // Take only up to batch size
    const batchToProcess = dueItems.slice(0, this.batchSize);

    // Remove processed items from queue
    this.publishQueue = this.publishQueue.filter(p => !batchToProcess.includes(p));

    logger.info('📤 Processing scheduled batch', {
      batchSize: batchToProcess.length,
      remainingInQueue: this.publishQueue.length,
      highPriorityCount: batchToProcess.filter(p => p.priority === 'high').length
    });

    // Process batch with concurrency control
    await this.processBatchWithConcurrency(batchToProcess);

    // Remove high priority flag for processed devices
    const processedDevices = new Set(batchToProcess.map(p => p.deviceId));
    for (const deviceId of processedDevices) {
      this.highPriorityDevices.delete(deviceId);
    }
  }

  private async processBatchWithConcurrency(batch: ScheduledPublish[]): Promise<void> {
    const concurrencyLimit = 10; // Process 10 devices concurrently
    const results = [];

    for (let i = 0; i < batch.length; i += concurrencyLimit) {
      const chunk = batch.slice(i, i + concurrencyLimit);
      const chunkPromises = chunk.map(async (item) => {
        try {
          await this.publishScreenForDevice(item.deviceId, item.screenType);
        } catch (error) {
          logger.error('Failed to publish screen', {
            deviceId: item.deviceId,
            screenType: item.screenType,
            error
          });
        }
      });

      results.push(...await Promise.all(chunkPromises));

      // Small delay between chunks to prevent overwhelming
      if (i + concurrencyLimit < batch.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  private async publishScreenForDevice(
    deviceId: string,
    screenType: 'instagram' | 'gmb' | 'pos' | 'promotion'
  ): Promise<void> {
    const root = this.mqttClient.getTopicRoot();

    // Get device details from cache
    const cache = getActiveDeviceCache();
    const device = await cache.getDevice(deviceId);

    if (!device) {
      logger.debug('Device no longer active, skipping', { deviceId });
      return;
    }

    switch (screenType) {
      case 'instagram':
        await this.publishInstagram(deviceId, root, device.userId || undefined);
        break;
      case 'gmb':
        await this.publishGmb(deviceId, root);
        break;
      case 'pos':
        await this.publishPos(deviceId, root);
        break;
      case 'promotion':
        await this.publishPromotion(device, root);
        break;
    }

    // Schedule next publication for this device/screen
    this.scheduleNextPublication(deviceId, screenType);
  }

  private scheduleNextPublication(
    deviceId: string,
    screenType: 'instagram' | 'gmb' | 'pos' | 'promotion'
  ): void {
    const now = Date.now();

    // Calculate next publish time with some randomization
    // Base interval of 60 seconds + random offset up to 30 seconds
    // This spreads out the load naturally
    const randomOffset = Math.floor(Math.random() * this.maxDelay);
    const nextPublishTime = now + this.baseInterval + randomOffset;

    this.publishQueue.push({
      deviceId,
      screenType,
      scheduledTime: nextPublishTime,
      priority: 'normal'
    });

    logger.debug('Scheduled next publication', {
      deviceId,
      screenType,
      nextTime: new Date(nextPublishTime).toISOString(),
      delay: this.baseInterval + randomOffset
    });
  }

  // Public method to trigger event-based publishing
  async triggerEventPublish(deviceId: string, eventType: string): Promise<void> {
    try {
      const cache = getActiveDeviceCache();
      const device = await cache.getDevice(deviceId);

      if (!device) {
        logger.debug('Device not active for event publish', { deviceId, eventType });
        return;
      }

      logger.info('⚡ Triggering event-based publish', { deviceId, eventType });

      // Map event to screen type
      let screenType: 'instagram' | 'gmb' | 'pos' | 'promotion' | null = null;

      switch (eventType) {
        case 'instagram_update':
          screenType = 'instagram';
          break;
        case 'gmb_update':
          screenType = 'gmb';
          break;
        case 'pos_update':
          screenType = 'pos';
          break;
        case 'ad_update':
        case 'campaign_update':
          screenType = 'promotion';
          break;
      }

      if (screenType) {
        // Add to queue with high priority
        this.publishQueue.push({
          deviceId,
          screenType,
          scheduledTime: Date.now(),
          priority: 'high'
        });

        logger.info('📢 Event queued for immediate publish', {
          deviceId,
          eventType,
          screenType
        });
      }
    } catch (error) {
      logger.error('Failed to trigger event publish', { deviceId, eventType, error });
    }
  }

  // Batch trigger for multiple devices (useful for bulk updates)
  async triggerBulkEventPublish(deviceIds: string[], eventType: string): Promise<void> {
    const now = Date.now();

    for (const deviceId of deviceIds) {
      // Add to queue with staggered timing to avoid spikes
      this.publishQueue.push({
        deviceId,
        screenType: this.mapEventToScreenType(eventType),
        scheduledTime: now + Math.floor(Math.random() * 10000), // Spread over 10 seconds
        priority: 'high'
      });
    }

    logger.info('📢 Bulk events queued', {
      count: deviceIds.length,
      eventType
    });
  }

  private mapEventToScreenType(eventType: string): any {
    switch (eventType) {
      case 'instagram_update': return 'instagram';
      case 'gmb_update': return 'gmb';
      case 'pos_update': return 'pos';
      case 'ad_update':
      case 'campaign_update': return 'promotion';
      default: return 'promotion';
    }
  }

  private async publishInstagram(deviceId: string, root: string, userId?: string): Promise<void> {
    // ── Kafka path (production): trigger a real API fetch ──────────────────
    if (this.kafkaService?.connected) {
      try {
        await this.kafkaService.publishInstagramFetchRequest(deviceId, 'scheduled', userId);
        logger.debug('📸 [STATS] Instagram fetch request sent via Kafka', { deviceId });
        return;
      } catch (err: unknown) {
        logger.warn('[STATS] Kafka publish failed, falling back to mock Instagram data', {
          deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // ── Fallback path (dev / Kafka unavailable): send mock data directly ───
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
          message: 'yey!, you made it!',
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
  }

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
  }

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
  }

  private async publishPromotion(device: ActiveDevice, root: string): Promise<void> {
    const { deviceId, userId, adManagementEnabled, brandCanvasEnabled } = device;

    try {
      if (!userId) {
        logger.info('🎨 [PROMOTION] No userId in cache — sending default canvas', { deviceId });
        await this.publishDefaultCanvas(deviceId, root);
        return;
      }

      let canvasMode: 'PROMOTION' | 'BRAND' | 'DEFAULT';
      if (adManagementEnabled) {
        canvasMode = 'PROMOTION';
      } else if (brandCanvasEnabled) {
        canvasMode = 'BRAND';
      } else {
        canvasMode = 'DEFAULT';
      }

      if (canvasMode === 'DEFAULT') {
        await this.publishDefaultCanvas(deviceId, root);
        return;
      }

      const userOid = new mongoose.Types.ObjectId(userId);
      const adType = canvasMode === 'PROMOTION' ? AdType.PROMOTION : AdType.BRAND_CANVAS;
      const ad = await Ad.findOne({
        userId: userOid,
        type: adType,
        status: AdStatus.RUNNING
      }).sort({ createdAt: -1 });

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
    logger.debug('Published default canvas', { deviceId });
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

  private async cleanupInactiveDeviceState(activeDevices: Set<string>): Promise<void> {
    let removed = 0;
    for (const deviceId of this.deviceState.keys()) {
      if (!activeDevices.has(deviceId)) {
        this.deviceState.delete(deviceId);
        removed++;
      }
    }

    // Also clean up queue for inactive devices
    this.publishQueue = this.publishQueue.filter(p => activeDevices.has(p.deviceId));

    if (removed > 0) {
      logger.debug('Cleaned up inactive device state', {
        removed,
        remaining: this.deviceState.size,
        queueSize: this.publishQueue.length
      });
    }
  }
}
