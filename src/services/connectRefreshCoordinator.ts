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
import { getIgDeviceRuntimeCache } from './igDeviceRuntimeCache';
import { Provider } from '../models/Social';
import {
  buildGmbScreenPayload,
  buildInstagramScreenPayload,
  buildScreenEnvelope
} from './screenEnvelope';
import type { IntegrationConnectAction } from '../utils/parseConnectProvider';

export type ConnectRefreshCoordinatorDeps = {
  mqttClient: MqttClientManager;
  redisService: RedisService | null;
  instagramPoller: InstagramPoller | null;
  instagramPriorityTtlMs: number;
  gmbConnectPull: GmbConnectPull;
};

export type IntegrationStatusChange = {
  provider: Provider;
  action: IntegrationConnectAction;
};

export class ConnectRefreshCoordinator {
  constructor(private readonly deps: ConnectRefreshCoordinatorDeps) {}

  async onStatusChanged(deviceId: string, meta: IntegrationStatusChange): Promise<void> {
    if (meta.action === 'disconnect') {
      await this.publishDisconnected(deviceId, meta.provider);
      return;
    }
    await this.refresh(deviceId);
  }

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

    if (integrations.instagram) {
      getIgDeviceRuntimeCache().setIgNoCredentials(deviceId, false);
      if (instagramPoller) {
        if (await shouldSkipForStimulate(deviceId, 'instagram')) {
          logger.info('[STIM_SKIP] Connect refresh skipping Instagram for stim device', { deviceId });
        } else {
          tasks.push(this.refreshInstagram(deviceId));
        }
      }
    } else {
      getIgDeviceRuntimeCache().setIgNoCredentials(deviceId, true);
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

  /** Zeroed IG/GMB screen after unlink — no Graph/GMB API calls. */
  async publishDisconnected(deviceId: string, provider: Provider): Promise<void> {
    const mqttClient = this.deps.mqttClient;
    const mqttReady = await mqttClient.waitUntilConnected({ timeoutMs: 12_000 });
    if (!mqttReady) {
      logger.warn('[INTEGRATIONS_DISCONNECT] MQTT not ready — zeroed screen skipped', { deviceId });
      return;
    }

    await clearAllPublishHashesForDevice(deviceId);

    const platform = provider === Provider.INSTAGRAM ? 'instagram' : 'gmb';
    if (await shouldSkipForStimulate(deviceId, platform)) {
      logger.info('[STIM_SKIP] Disconnect screen skip', { deviceId, provider });
      return;
    }

    const root = mqttClient.getTopicRoot();
    try {
      if (provider === Provider.INSTAGRAM) {
        const { payload: screenPayload, envelopeOpts } = buildInstagramScreenPayload({ followers: 0 });
        const envelope = buildScreenEnvelope('instagram', screenPayload, envelopeOpts);
        const topic = `${root}/${deviceId}/instagram`;
        await mqttClient.publish({
          topic,
          payload: JSON.stringify(envelope),
          qos: 1,
          retain: false
        });
        logger.info('[INTEGRATIONS_DISCONNECT] Published zeroed Instagram screen', { deviceId, topic });
        return;
      }

      const { payload: screenPayload, envelopeOpts } = buildGmbScreenPayload({
        verifiedReview: 0,
        reviews: []
      });
      const envelope = buildScreenEnvelope('gmb', screenPayload, envelopeOpts);
      const topic = `${root}/${deviceId}/gmb`;
      await mqttClient.publish({
        topic,
        payload: JSON.stringify(envelope),
        qos: 1,
        retain: false
      });
      logger.info('[INTEGRATIONS_DISCONNECT] Published zeroed GMB screen', { deviceId, topic });
    } catch (err: unknown) {
      logger.warn('[INTEGRATIONS_DISCONNECT] Zeroed screen publish failed', {
        deviceId,
        provider,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}
