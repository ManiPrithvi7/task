import { logger } from '../utils/logger';
import { MqttClientManager } from '../servers/mqttClient';
import { DeviceService, getActiveDeviceCache, ActiveDevice } from './deviceService';
import { CAService } from './caService';
// TEMP STIMULATE — remove after testing
import { shouldSkipForStimulate } from '../utils/stimulateAllowlist';
import {
  buildGmbScreenPayload,
  buildInstagramScreenPayload,
  buildScreenEnvelope,
  gmbReviewMetrics
} from './screenEnvelope';
import { publishIfChanged } from './mqttChangeDetection';
import { getUserIntegrations } from './userIntegrationCache';

const SAMPLE_GMB_REVIEWS = [
  { id: 1, googleReview: 'Best latte in Portland.', rating: '4' },
  { id: 2, googleReview: 'Amazing pastries.', rating: '5' },
  { id: 3, googleReview: 'Staff always friendly.', rating: '4' }
];

function gmbDemoVariant(label: 'v6_normal' | 'v6_mini' | 'v6_mega', verifiedReview: number) {
  const built = buildGmbScreenPayload({
    verifiedReview,
    rating: 4,
    qrText: 'https://g.page/r/...',
    reviews: SAMPLE_GMB_REVIEWS
  });
  return {
    label,
    muted: built.envelopeOpts.muted!,
    celebration: built.envelopeOpts.celebration!,
    payload: built.payload
  };
}

/**
 * Canonical PROOF Display v1.2 GMB payloads for `.../gmb` (firmware listens here for celebration flows).
 * Cycles normal → mini → mega. `.../test-gmb` uses a separate muted progression publish — see `publishTestGmb`.
 */
const TEST_GMB_V6_VARIANTS = [
  gmbDemoVariant('v6_normal', 42),
  gmbDemoVariant('v6_mini', 15),
  gmbDemoVariant('v6_mega', 25)
];

/** Per-device state for Instagram, GMB (for mock rotation). */
interface DeviceScreenState {
  instagram: { followers: number; target: number };
  gmb: { reviews: number; rating: number };
  /** testGmbCycle: index into TEST_GMB_V6_VARIANTS for canonical /gmb publishes (variant rotation). */
  gmbTest: { testGmbCycle: number };
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
    logger.info('📈 Starting screen publisher (Instagram, GMB)', {
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
          businessId: d.businessId || '(none)',
          lastSeen: new Date(d.lastSeen).toISOString()
        }))
      });

      for (const device of activeDevices) {
        // TEMP STIMULATE — remove after testing
        if (await shouldSkipForStimulate(device.deviceId, 'instagram')) {
          logger.debug('[STIM_SKIP] StatsPublisher skipping stim device', { deviceId: device.deviceId });
          continue;
        }
        try {
          // test-gmb: dev/QA mock only. Skip when user has GMB connected (real data via connect pull + webhooks).
          const publishTestGmb =
            process.env.STATS_PUBLISHER_TEST_GMB === 'true' ||
            !(device.businessId && (await getUserIntegrations(device.businessId))?.gmb);
          if (publishTestGmb) {
            try {
              await this.publishTestGmb(device.deviceId, root);
            } catch (err: unknown) {
              logger.warn('Failed to publish test GMB screen', {
                deviceId: device.deviceId,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          } else {
            logger.info('[PUBLISH_CYCLE] Skipping test-gmb — business has GMB integration', {
              deviceId: device.deviceId,
              businessId: device.businessId
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
        gmbTest: { testGmbCycle: 0 }
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
    const built = buildInstagramScreenPayload({
      followers,
      qrText: 'https://ig.com/handle'
    });
    const envelope = buildScreenEnvelope('instagram', built.payload, built.envelopeOpts);

    await this.mqttClient.publish({
      topic: `${root}/${deviceId}/instagram`,
      payload: JSON.stringify(envelope),
      qos: 1,
      retain: false
    });
    logger.debug('Published Instagram screen', {
      deviceId,
      followers,
      achievement: built.payload.achievement,
      progress: built.payload.progress
    });
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
