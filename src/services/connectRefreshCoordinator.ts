import type { MqttClientManager } from '../servers/mqttClient';
import type { InstagramPoller } from './instagramService';
import type { StatsPublisher } from './statsPublisher';
import type { GmbConnectPull } from './gmbConnectPull';
import type { PosConnectPull } from './posConnectPull';
import type { RedisService } from './redisService';
import { logger } from '../utils/logger';

const CONNECT_REFRESH_DEBOUNCE_SEC = 30;
const CONNECT_REFRESH_KEY_PREFIX = 'device:connect_refresh:';

export type ConnectRefreshCoordinatorDeps = {
  mqttClient: MqttClientManager;
  redisService: RedisService | null;
  instagramPoller: InstagramPoller | null;
  instagramPriorityTtlMs: number;
  gmbConnectPull: GmbConnectPull;
  posConnectPull: PosConnectPull;
  statsPublisher: StatsPublisher;
};

export class ConnectRefreshCoordinator {
  constructor(private readonly deps: ConnectRefreshCoordinatorDeps) {}

  async refresh(deviceId: string): Promise<void> {
    if (await this.isDebounced(deviceId)) {
      logger.debug('[CONNECT_REFRESH] Skipped — debounced', { deviceId });
      return;
    }

    const root = this.deps.mqttClient.getTopicRoot();
    const { mqttClient, instagramPoller, gmbConnectPull, posConnectPull, statsPublisher } = this.deps;

    const igRefresh = this.refreshInstagram(deviceId);

    const mqttReady = await mqttClient.waitUntilConnected({ timeoutMs: 12_000 });
    if (!mqttReady) {
      logger.warn('[CONNECT_REFRESH] MQTT not ready — screen publishes may retry inline', { deviceId });
    }

    await Promise.allSettled([
      igRefresh,
      gmbConnectPull.publishForDevice(deviceId, root),
      posConnectPull.publishForDevice(deviceId, root),
      statsPublisher.publishPromotionForDevice(deviceId, root)
    ]);
  }

  private async refreshInstagram(deviceId: string): Promise<void> {
    const poller = this.deps.instagramPoller;
    if (!poller) return;

    try {
      if (this.deps.redisService?.isRedisConnected()) {
        await poller.markPriority(deviceId, this.deps.instagramPriorityTtlMs);
      }
      await poller.requestImmediateFetch(deviceId, { trigger: 'connect' });
    } catch (err: unknown) {
      logger.warn('[CONNECT_REFRESH] Instagram refresh failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async isDebounced(deviceId: string): Promise<boolean> {
    const redis = this.deps.redisService;
    if (!redis?.isRedisConnected()) return false;

    try {
      const key = `${CONNECT_REFRESH_KEY_PREFIX}${deviceId}`;
      const set = await redis.getClient().set(key, '1', { EX: CONNECT_REFRESH_DEBOUNCE_SEC, NX: true });
      return set !== 'OK';
    } catch (err: unknown) {
      logger.debug('[CONNECT_REFRESH] Debounce check failed — proceeding', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }
}
