import type { MqttClientManager } from '../servers/mqttClient';
import type { InstagramPoller } from './instagramService';
import type { GmbConnectPull } from './gmbConnectPull';
import type { RedisService } from './redisService';
import { logger } from '../utils/logger';
import { clearAllPublishHashesForDevice } from './mqttChangeDetection';
import { getUserIntegrations, cacheUserIntegrations } from './userIntegrationCache';
import { getActiveDeviceCache } from './deviceService';
// TEMP STIMULATE — remove after testing
import { shouldSkipForStimulate } from '../utils/stimulateAllowlist';

export type ConnectRefreshCoordinatorDeps = {
  mqttClient: MqttClientManager;
  redisService: RedisService | null;
  instagramPoller: InstagramPoller | null;
  instagramPriorityTtlMs: number;
  gmbConnectPull: GmbConnectPull;
};

export class ConnectRefreshCoordinator {
  constructor(private readonly deps: ConnectRefreshCoordinatorDeps) {}

  async refresh(deviceId: string): Promise<void> {
    const root = this.deps.mqttClient.getTopicRoot();
    const { mqttClient, instagramPoller, gmbConnectPull } = this.deps;

    const device = await getActiveDeviceCache().getActive(deviceId);
    if (!device?.businessId) {
      logger.debug('[CONNECT_REFRESH] No businessId on active device', { deviceId });
      return;
    }

    let integrations = await getUserIntegrations(device.businessId);
    if (!integrations) {
      integrations = await cacheUserIntegrations(device.businessId);
    }

    const mqttReady = await mqttClient.waitUntilConnected({ timeoutMs: 12_000 });
    if (!mqttReady) {
      logger.warn('[CONNECT_REFRESH] MQTT not ready — screen publishes may retry inline', { deviceId });
    }

    await clearAllPublishHashesForDevice(deviceId);

    if (!integrations) {
      logger.warn('[CONNECT_REFRESH] No integrations cached or found', {
        deviceId,
        businessId: device.businessId
      });
      return;
    }

    const tasks: Promise<unknown>[] = [];

    if (integrations.instagram && instagramPoller) {
      if (await shouldSkipForStimulate(deviceId, 'instagram')) {
        logger.info('[STIM_SKIP] Connect refresh skipping Instagram for stim device', { deviceId });
      } else {
        tasks.push(this.refreshInstagram(deviceId));
      }
    }

    if (integrations.gmb) {
      if (await shouldSkipForStimulate(deviceId, 'gmb')) {
        logger.info('[STIM_SKIP] Connect refresh skipping GMB for stim device', { deviceId });
      } else {
        tasks.push(gmbConnectPull.publishForDevice(deviceId, root));
      }
    }

    const screenPulls = await Promise.allSettled(tasks);

    const failed = screenPulls.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      logger.debug('[CONNECT_REFRESH] Some screen pulls failed', { deviceId, failed: failed.length });
    }
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

}
