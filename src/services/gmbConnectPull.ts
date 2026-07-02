import type { MqttClientManager } from '../servers/mqttClient';
import type { WebhookConfig } from '../config/webhookConfig';
import { publishGmbScreen } from '../webhooks/delivery/publishGmbScreen';
import { resolveGmbContextForDevice } from '../lib/socials/resolveDeviceGmb';
import { syncGmbLocationForDevice } from '../lib/socials/syncDeviceGmb';
import { getActiveDeviceCache } from './deviceService';
import { getUserIntegrations } from './userIntegrationCache';
import { logger } from '../utils/logger';

export class GmbConnectPull {
  constructor(
    private readonly mqttClient: MqttClientManager,
    private readonly mqttPublishEnabled: boolean,
    private readonly webhookConfig: WebhookConfig
  ) {}

  async publishForDevice(deviceId: string, topicRoot: string): Promise<void> {
    let ctx = await resolveGmbContextForDevice(deviceId);
    if (!ctx) {
      const active = await getActiveDeviceCache().getActive(deviceId);
      const integrations = active?.userId ? await getUserIntegrations(active.userId) : null;
      ctx = await syncGmbLocationForDevice(deviceId, this.webhookConfig, {
        knownLocationId: integrations?.gmb?.locationId
      });
    }
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',hypothesisId:'H2',location:'gmbConnectPull.ts:publishForDevice',message:'gmb connect pull resolved context',data:{deviceId,ctxFound:Boolean(ctx),mqttPublishEnabled:this.mqttPublishEnabled,verifiedReview:ctx?.verifiedReviewCount??null,rating:ctx?.averageRating??null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (!ctx) {
      logger.info('[GMB_CONNECT] No GMB snapshot to publish', {
        deviceId,
        reason: 'no_mongo_location_and_gbp_api_returned_none'
      });
      return;
    }

    const rating =
      typeof ctx.averageRating === 'number' && Number.isFinite(ctx.averageRating)
        ? ctx.averageRating
        : undefined;

    await publishGmbScreen(
      this.mqttClient,
      topicRoot,
      deviceId,
      {
        verifiedReview: ctx.verifiedReviewCount,
        rating,
        celebration: 'false'
      },
      this.mqttPublishEnabled,
      { userId: ctx.userId, deviceId }
    );

    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/b23bd0da-dae5-4d29-96a5-e5f39343cdd6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bf7e3f'},body:JSON.stringify({sessionId:'bf7e3f',hypothesisId:'H3',location:'gmbConnectPull.ts:publishForDevice',message:'gmb connect pull publishGmbScreen completed',data:{deviceId,topic:`${topicRoot}/${deviceId}/gmb`},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    logger.debug('[GMB_CONNECT] Published GMB snapshot from Mongo', {
      deviceId,
      verifiedReview: ctx.verifiedReviewCount,
      rating
    });
  }
}
