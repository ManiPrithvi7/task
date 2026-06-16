/**
 * MQTT OTA command publisher — per-device ota_update delivery.
 */

import type { MqttClientManager } from '../servers/mqttClient';
import { Device, DeviceOtaState } from '../models/Device';
import { logger } from '../utils/logger';
import type { OtaUpdateOffer } from './otaService';
import type { OtaRedisState } from './otaRedisState';

export interface OtaUpdateCommandPayload {
  cmd: 'ota_update';
  version: string;
  download_url: string;
  sha256: string;
  signature: string;
  size_bytes: number;
  force: boolean;
  issued_at: string;
}

export class OtaCommandPublisher {
  constructor(
    private readonly mqttClient: MqttClientManager,
    private readonly topicRoot: string,
    private readonly broadcastTopic: string,
    private readonly otaRedisState?: OtaRedisState
  ) {}

  async publishUpdateToDevice(
    deviceId: string,
    offer: OtaUpdateOffer,
    force = false
  ): Promise<void> {
    const payload: OtaUpdateCommandPayload = {
      cmd: 'ota_update',
      version: offer.version,
      download_url: offer.downloadUrl,
      sha256: offer.sha256,
      signature: offer.signature,
      size_bytes: offer.sizeBytes,
      force,
      issued_at: new Date().toISOString()
    };

    const topic = `${this.topicRoot}/${deviceId}/cmd`;
    await this.mqttClient.publish(
      {
        topic,
        payload: JSON.stringify(payload),
        qos: 2,
        retain: false
      },
      {
        deviceId,
        onDelivered: this.otaRedisState
          ? () => {
              void this.otaRedisState!.markDelivered(deviceId, offer.version).catch((err: unknown) => {
                logger.warn('[OTA] markDelivered failed after MQTT ack', {
                  deviceId,
                  version: offer.version,
                  error: err instanceof Error ? err.message : String(err)
                });
              });
            }
          : undefined
      }
    );

    await Device.updateOne(
      { clientId: deviceId },
      {
        $set: {
          otaState: DeviceOtaState.NOTIFIED,
          otaTargetVersion: offer.version
        }
      }
    );

    logger.info('[OTA] Published ota_update cmd', { deviceId, version: offer.version, topic });
  }

  async publishBroadcastUpdate(offer: OtaUpdateOffer, force = false): Promise<void> {
    const payload: OtaUpdateCommandPayload = {
      cmd: 'ota_update',
      version: offer.version,
      download_url: offer.downloadUrl,
      sha256: offer.sha256,
      signature: offer.signature,
      size_bytes: offer.sizeBytes,
      force,
      issued_at: new Date().toISOString()
    };

    await this.mqttClient.publish({
      topic: this.broadcastTopic,
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false
    });

    logger.info('[OTA] Published broadcast ota_update', {
      version: offer.version,
      topic: this.broadcastTopic
    });
  }

  async publishRollbackAck(deviceId: string, version: string): Promise<void> {
    const topic = `${this.topicRoot}/${deviceId}/ack`;
    await this.mqttClient.publish({
      topic,
      payload: JSON.stringify({
        cmd: 'ota_rollback_received',
        version,
        received_at: new Date().toISOString()
      }),
      qos: 1,
      retain: false
    });

    logger.info('[OTA] Published rollback ack', { deviceId, version, topic });
  }
}
