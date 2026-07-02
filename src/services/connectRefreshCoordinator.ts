import type { MqttClientManager } from '../servers/mqttClient';
import type { InstagramPoller } from './instagramService';
import type { StatsPublisher } from './statsPublisher';
import type { GmbConnectPull } from './gmbConnectPull';
import type { RedisService } from './redisService';
import { logger } from '../utils/logger';
import { clearAllPublishHashesForDevice } from './mqttChangeDetection';
import { getUserIntegrations, cacheUserIntegrations } from './userIntegrationCache';
import { getActiveDeviceCache } from './deviceService';

const CONNECT_REFRESH_DEBOUNCE_SEC = 30;
const CONNECT_REFRESH_KEY_PREFIX = 'device:connect_refresh:';

export type ConnectRefreshCoordinatorDeps = {
  mqttClient: MqttClientManager;
  redisService: RedisService | null;
  instagramPoller: InstagramPoller | null;
  instagramPriorityTtlMs: number;
  gmbConnectPull: GmbConnectPull;
  statsPublisher: StatsPublisher;
};

export class ConnectRefreshCoordinator {
  constructor(private readonly deps: ConnectRefreshCoordinatorDeps) {}

  async refresh(deviceId: string): Promise<void> {
    const promotionDebounced = await this.isDebounced(deviceId);

    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',runId:'post-fix',hypothesisId:'H6',location:'connectRefreshCoordinator.ts:refresh',message:'connect refresh entered',data:{deviceId,promotionDebounced},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const root = this.deps.mqttClient.getTopicRoot();
    const { mqttClient, instagramPoller, gmbConnectPull, statsPublisher } = this.deps;

    const device = await getActiveDeviceCache().getActive(deviceId);
    if (!device?.userId) {
      logger.debug('[CONNECT_REFRESH] No userId on active device', { deviceId });
      return;
    }

    let integrations = await getUserIntegrations(device.userId);
    if (!integrations) {
      integrations = await cacheUserIntegrations(device.userId);
    }

    const mqttReady = await mqttClient.waitUntilConnected({ timeoutMs: 12_000 });
    if (!mqttReady) {
      logger.warn('[CONNECT_REFRESH] MQTT not ready — screen publishes may retry inline', { deviceId });
    }

    const clearedHashes = promotionDebounced
      ? 0
      : await clearAllPublishHashesForDevice(deviceId);

    if (!integrations) {
      logger.warn('[CONNECT_REFRESH] No integrations cached or found', {
        deviceId,
        userId: device.userId
      });
      if (!promotionDebounced) {
        try {
          await statsPublisher.publishPromotionForDevice(deviceId, root, { force: true });
        } catch (err: unknown) {
          logger.warn('[CONNECT_REFRESH] Promotion publish failed', {
            deviceId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      return;
    }

    const tasks: Promise<unknown>[] = [];

    if (integrations.instagram && instagramPoller) {
      tasks.push(this.refreshInstagram(deviceId));
    }

    if (integrations.gmb) {
      tasks.push(gmbConnectPull.publishForDevice(deviceId, root));
    }

    if (promotionDebounced) {
      logger.info('[CONNECT_REFRESH] Screen pulls only (promotion debounced)', {
        deviceId,
        hasGmb: Boolean(integrations.gmb),
        hasInstagram: Boolean(integrations.instagram)
      });
    }

    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',runId:'post-fix',hypothesisId:'H1',location:'connectRefreshCoordinator.ts:refresh',message:'connect refresh integration gate',data:{deviceId,userId:device.userId,promotionDebounced,hasGmb:Boolean(integrations.gmb),hasInstagram:Boolean(integrations.instagram),gmbTaskQueued:Boolean(integrations.gmb),taskCount:tasks.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const screenPulls = await Promise.allSettled(tasks);

    if (!promotionDebounced) {
      try {
        await statsPublisher.publishPromotionForDevice(deviceId, root, { force: true });
        logger.info('[CONNECT_REFRESH] Promotion published (connect force)', { deviceId, clearedHashes });
      } catch (err: unknown) {
        logger.warn('[CONNECT_REFRESH] Promotion publish failed', {
          deviceId,
          clearedHashes,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const failed = screenPulls.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      logger.debug('[CONNECT_REFRESH] Some screen pulls failed', { deviceId, failed: failed.length });
    }
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',runId:'post-fix',hypothesisId:'H4',location:'connectRefreshCoordinator.ts:refresh',message:'connect refresh screen pulls settled',data:{deviceId,promotionDebounced,total:screenPulls.length,rejected:failed.length,rejectedReasons:failed.map((r)=>r.status==='rejected'?(r.reason instanceof Error?r.reason.message:String(r.reason)):null)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
