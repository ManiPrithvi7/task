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
import { isConnectBurstDevice } from '../config/instagramPollingConfig';
import { getScreenLiveHub } from './screenLiveHub';
import {
  clearDeviceHashFields,
  getIgDeviceRuntimeCache,
  IG_STIM_POLLUTION_HASH_FIELDS,
  GMB_STIM_POLLUTION_HASH_FIELDS
} from './igDeviceRuntimeCache';
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
    const runtime = getIgDeviceRuntimeCache();
    const businessId = device?.businessId?.trim() || runtime.getBusinessId(deviceId) || '';
    if (!businessId) {
      if (isConnectBurstDevice(deviceId) && runtime.hasInstagramCredentials(deviceId)) {
        runtime.setIgNoCredentials(deviceId, false);
        logger.info('[CONNECT_REFRESH] Starting connect burst from cached Instagram credentials', {
          deviceId
        });
        await this.refreshInstagram(deviceId);
        return;
      }
      logger.info('[CONNECT_REFRESH] No businessId on active device — connect fetch skipped', { deviceId });
      return;
    }

    let integrations = await getUserIntegrations(businessId);
    if (!integrations) {
      integrations = await cacheUserIntegrations(businessId);
    }

    const mqttReady = await mqttClient.waitUntilConnected({ timeoutMs: 12_000 });
    if (!mqttReady) {
      logger.warn('[CONNECT_REFRESH] MQTT not ready — screen publishes may retry inline', { deviceId });
    }

    await clearAllPublishHashesForDevice(deviceId);

    if (!integrations) {
      logger.warn('[CONNECT_REFRESH] No integrations cached or found', {
        deviceId,
        businessId
      });
      // Clear retained broker screens so stale stim/social values do not reappear
      await this.clearAbsentScreens(deviceId, { instagram: true, gmb: true });
      return;
    }

    const tasks: Promise<unknown>[] = [];
    const instagramLinked =
      Boolean(integrations.instagram) ||
      Boolean(device?.instagramAccountId?.trim() && device?.accessToken?.trim()) ||
      runtime.hasInstagramCredentials(deviceId);

    if (instagramLinked) {
      runtime.setIgNoCredentials(deviceId, false);
      if (instagramPoller) {
        if (await shouldSkipForStimulate(deviceId, 'instagram')) {
          logger.info('[STIM_SKIP] Connect refresh skipping Instagram for stim device', { deviceId });
        } else {
          if (!integrations.instagram) {
            logger.info('[CONNECT_REFRESH] Instagram linked on device hash — starting fetch', {
              deviceId
            });
          }
          tasks.push(this.refreshInstagram(deviceId));
        }
      }
    } else {
      runtime.setIgNoCredentials(deviceId, true);
      tasks.push(this.clearAbsentScreens(deviceId, { instagram: true, gmb: false }));
    }

    if (integrations.gmb) {
      if (await shouldSkipForStimulate(deviceId, 'gmb')) {
        logger.info('[STIM_SKIP] Connect refresh skipping GMB for stim device', { deviceId });
      } else {
        tasks.push(gmbConnectPull.publishForDevice(deviceId, root));
      }
    } else {
      tasks.push(this.clearAbsentScreens(deviceId, { instagram: false, gmb: true }));
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
      if (isConnectBurstDevice(deviceId)) {
        await poller.startConnectBurst(deviceId);
        return;
      }
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

  /**
   * Overwrite retained broker screen(s) with zeros when the account is not linked.
   * Uses retain:true so the device stops showing the last stim/social publish.
   */
  private async clearAbsentScreens(
    deviceId: string,
    which: { instagram: boolean; gmb: boolean }
  ): Promise<void> {
    const runtime = getIgDeviceRuntimeCache();
    if (which.instagram) {
      if (!(await shouldSkipForStimulate(deviceId, 'instagram'))) {
        await clearDeviceHashFields(deviceId, [...IG_STIM_POLLUTION_HASH_FIELDS]);
        runtime.clearFollowerCount(deviceId);
        await this.publishZeroedScreen(deviceId, Provider.INSTAGRAM, 'connect_no_account');
      }
    }
    if (which.gmb) {
      if (!(await shouldSkipForStimulate(deviceId, 'gmb'))) {
        await clearDeviceHashFields(deviceId, [...GMB_STIM_POLLUTION_HASH_FIELDS]);
        runtime.clearGmbReviewCount(deviceId);
        await this.publishZeroedScreen(deviceId, Provider.GOOGLE_BUSINESS, 'connect_no_account');
      }
    }
  }

  private async publishZeroedScreen(
    deviceId: string,
    provider: Provider,
    reason: 'disconnect' | 'connect_no_account'
  ): Promise<void> {
    const mqttClient = this.deps.mqttClient;
    const mqttReady = await mqttClient.waitUntilConnected({ timeoutMs: 12_000 });
    if (!mqttReady) {
      logger.warn('[CONNECT_REFRESH] MQTT not ready — zeroed screen skipped', {
        deviceId,
        provider,
        reason
      });
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
          retain: true
        });
        logger.info('[CONNECT_REFRESH] Published zeroed Instagram screen (clears retained)', {
          deviceId,
          topic,
          reason
        });
        if (isConnectBurstDevice(deviceId)) {
          getScreenLiveHub().pushFollowers(deviceId, 0);
        }
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
        retain: true
      });
      logger.info('[CONNECT_REFRESH] Published zeroed GMB screen (clears retained)', {
        deviceId,
        topic,
        reason
      });
      if (isConnectBurstDevice(deviceId)) {
        getScreenLiveHub().pushReviews(deviceId, 0);
      }
    } catch (err: unknown) {
      logger.warn('[CONNECT_REFRESH] Zeroed screen publish failed', {
        deviceId,
        provider,
        reason,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /** Zeroed IG/GMB screen after unlink — retain:true clears broker retained payload. */
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

    if (provider === Provider.INSTAGRAM) {
      await clearDeviceHashFields(deviceId, [...IG_STIM_POLLUTION_HASH_FIELDS]);
      getIgDeviceRuntimeCache().clearFollowerCount(deviceId);
    } else {
      await clearDeviceHashFields(deviceId, [...GMB_STIM_POLLUTION_HASH_FIELDS]);
      getIgDeviceRuntimeCache().clearGmbReviewCount(deviceId);
    }

    await this.publishZeroedScreen(deviceId, provider, 'disconnect');
  }
}
