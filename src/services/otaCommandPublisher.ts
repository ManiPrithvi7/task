/**
 * MQTT OTA command publisher — push updates to device or broadcast topics.
 */

import type { MqttClientManager } from '../servers/mqttClient';
import { Device, DeviceOtaState } from '../models/Device';
import { logger } from '../utils/logger';
import type { OtaUpdateOffer } from './otaService';

export type OtaPushMode = 'full' | 'trigger';

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

export interface OtaCheckTriggerPayload {
  cmd: 'ota_check';
  force: boolean;
  hint_version?: string;
  issued_at: string;
}

export class OtaCommandPublisher {
  constructor(
    private readonly mqttClient: MqttClientManager,
    private readonly topicRoot: string,
    private readonly broadcastTopic: string
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
    await this.mqttClient.publish({
      topic,
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false
    });

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

  async publishCheckTrigger(
    deviceId: string,
    hintVersion?: string,
    force = false
  ): Promise<void> {
    const payload: OtaCheckTriggerPayload = {
      cmd: 'ota_check',
      force,
      ...(hintVersion ? { hint_version: hintVersion } : {}),
      issued_at: new Date().toISOString()
    };

    const topic = `${this.topicRoot}/${deviceId}/cmd`;
    await this.mqttClient.publish({
      topic,
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false
    });

    logger.info('[OTA] Published ota_check trigger', { deviceId, hintVersion, topic });
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
