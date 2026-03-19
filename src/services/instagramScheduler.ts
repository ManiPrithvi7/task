import { logger } from '../utils/logger';
import { ActiveDeviceCache } from './deviceService';
import { KafkaService } from './kafkaService';

export type InstagramFetchType = 'media' | 'insights' | 'both';

export interface InstagramSchedulerConfig {
  enabled: boolean;
  intervalMs: number;
  fetchType: InstagramFetchType;
}

export class InstagramScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private config: InstagramSchedulerConfig,
    private activeDeviceCache: ActiveDeviceCache,
    private kafka: KafkaService
  ) {}

  start(): void {
    if (!this.config.enabled) return;
    if (this.running) return;
    this.running = true;

    logger.info('🗓️ Instagram scheduler enabled', {
      intervalMs: this.config.intervalMs,
      fetchType: this.config.fetchType
    });

    this.timer = setInterval(() => {
      this.tick().catch(err => {
        logger.warn('Instagram scheduler tick failed', {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }, this.config.intervalMs);

    // run once immediately
    this.tick().catch(() => {});
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (!this.kafka.connected) return;

    const deviceIds = await this.activeDeviceCache.getAllActiveDeviceIds();
    if (deviceIds.length === 0) return;

    logger.info('📤 Instagram scheduler publishing fetch requests', {
      deviceCount: deviceIds.length
    });

    await Promise.all(
      deviceIds.map(deviceId =>
        this.kafka.produce(
          'instagram-fetch-requests',
          {
            deviceId,
            trigger: 'scheduled',
            requested_at: new Date().toISOString(),
            fetchType: this.config.fetchType
          },
          deviceId
        )
      )
    );
  }
}

