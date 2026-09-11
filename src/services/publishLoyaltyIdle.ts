/**
 * Retained loyalty-idle screen on `{topicRoot}/{deviceId}/loyalty` (v1.2 envelope).
 */

import { Device } from '../models/Device';
import { Business } from '../models/Business';
import { buildLoyaltyIdleEnvelope } from './screenEnvelope';
import { logger } from '../utils/logger';
import type { LoyaltyMqttClient } from './loyaltyService';

export async function resolveBusinessNameForDevice(deviceId: string): Promise<string | null> {
  const device = await Device.findOne({ clientId: deviceId }).select({ businessId: 1 }).lean();
  if (!device?.businessId) return null;

  const business = await Business.findById(device.businessId).select({ name: 1 }).lean();
  const name = business?.name?.trim();
  return name || null;
}

export function buildLoyaltyIdleMqttMessage(businessName: string, timestamp?: Date): string {
  return JSON.stringify(buildLoyaltyIdleEnvelope(businessName, timestamp));
}

export async function publishLoyaltyIdle(
  mqtt: LoyaltyMqttClient,
  topicRoot: string,
  deviceId: string,
  businessName: string
): Promise<void> {
  const trimmed = businessName.trim();
  if (!trimmed) {
    logger.debug('loyalty idle skip (empty businessName)', { deviceId });
    return;
  }
  if (!mqtt.isConnected()) {
    throw new Error('MQTT client not connected');
  }

  const topic = `${topicRoot}/${deviceId}/loyalty`;
  await mqtt.publish({
    topic,
    payload: buildLoyaltyIdleMqttMessage(trimmed),
    qos: 1,
    retain: true
  });

  logger.info('loyalty idle published', { deviceId, topic, businessName: trimmed });
}

export async function publishLoyaltyIdleForDevice(
  mqtt: LoyaltyMqttClient,
  topicRoot: string,
  deviceId: string
): Promise<void> {
  const businessName = await resolveBusinessNameForDevice(deviceId);
  if (!businessName) {
    logger.debug('loyalty idle skip (no business name)', { deviceId });
    return;
  }
  await publishLoyaltyIdle(mqtt, topicRoot, deviceId, businessName);
}
