import mongoose from 'mongoose';
import crypto from 'crypto';
import type { BootstrapHost } from './bootstrapHost';
import type { ActiveDevice } from '../services/deviceService';
import { Device } from '../models/Device';
import { clearAllPublishHashesForDevice } from '../services/mqttChangeDetection';
import { getLocalPromoRotationCache } from '../services/localCaches';
import { cacheUserIntegrations } from '../services/userIntegrationCache';
import { getDeviceStateLogService } from '../services/deviceStateLogService';
import { REDIS_KEYS } from '../services/instagramService';
import { parsePilotBootPayload, isPilotOtaStatusEvent, normalizeOtaEventKey } from '../utils/pilotOtaPayload';
import { logger } from '../utils/logger';

export function extractDeviceIdFromTopic(host: BootstrapHost, topic: string): string | null {
  const root = host.config.mqtt.topicRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = topic.match(new RegExp(`^${root}/([^/]+)/`));
  return match ? match[1] : null;
}

export async function sendRegistrationResponse(
  host: BootstrapHost,
  deviceId: string,
  success: boolean,
  message: string,
  isNewDevice: boolean = false
): Promise<void> {
  try {
    const response = {
      success,
      message,
      deviceId,
      isNewDevice,
      timestamp: new Date().toISOString(),
      serverVersion: '1.0.0'
    };

    await host.mqttClient.publish({
      topic: `${host.config.mqtt.topicRoot}/${deviceId}/registration_ack`,
      payload: JSON.stringify(response),
      qos: 1,
      retain: false
    });

    logger.info('📤 Registration response sent', {
      deviceId,
      success,
      isNewDevice
    });
  } catch (error: unknown) {
    logger.error('Failed to send registration response', {
      deviceId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function sendUnregistrationResponse(
  host: BootstrapHost,
  deviceId: string,
  success: boolean,
  message: string
): Promise<void> {
  try {
    const response = {
      success,
      message,
      deviceId,
      timestamp: new Date().toISOString(),
      serverVersion: '1.0.0',
      disconnectType: 'graceful'
    };

    await host.mqttClient.publish({
      topic: `${host.config.mqtt.topicRoot}/${deviceId}/unregistration_ack`,
      payload: JSON.stringify(response),
      qos: 1,
      retain: false
    });

    logger.info('📤 Un-registration response sent', {
      deviceId,
      success
    });
  } catch (error: unknown) {
    logger.error('Failed to send un-registration response', {
      deviceId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function cacheActiveDevice(host: BootstrapHost, deviceId: string): Promise<void> {
  try {
    logger.info('📋 [LIFECYCLE:CACHE] Step 1/2 — Device lookup (MongoDB)', { deviceId });
    const deviceDoc = await Device.findOne({ clientId: deviceId });
    if (!deviceDoc) {
      logger.warn('📋 [LIFECYCLE:CACHE] Device not found in MongoDB — caching defaults only', { deviceId });
      await host.activeDeviceCache.setActive({
        deviceId,
        userId: '',
        lastSeen: Date.now()
      });
      return;
    }

    logger.info('📋 [LIFECYCLE:CACHE] Step 2/2 — Social (Instagram) for device', {
      deviceId,
      userId: deviceDoc.userId?.toString() || 'none',
      deviceStatus: deviceDoc.status
    });

    const mongoUserId = deviceDoc.userId?.toString() || '';
    const hasLinkedMongoUser = Boolean(mongoUserId && mongoose.Types.ObjectId.isValid(mongoUserId));

    if (!hasLinkedMongoUser) {
      logger.info('📋 [LIFECYCLE:CACHE] Device has no Mongo userId — cannot load Instagram from Social', { deviceId });
    }

    const igFromSocial = hasLinkedMongoUser
      ? await host.loadLatestInstagramSocialForUser(mongoUserId)
      : null;
    if (hasLinkedMongoUser && !igFromSocial) {
      logger.warn('📋 [LIFECYCLE:CACHE] No INSTAGRAM `Social` row for owner — add Instagram for this user in the web app', {
        deviceId,
        userId: mongoUserId
      });
    }

    const active: ActiveDevice = {
      deviceId,
      userId: mongoUserId,
      lastSeen: Date.now(),
      ...(igFromSocial
        ? { instagramAccountId: igFromSocial.socialAccountId, accessToken: igFromSocial.accessToken }
        : {})
    };

    await host.activeDeviceCache.setActive(active);

    logger.info('📋 [LIFECYCLE:CACHE] Active device record written (Mongo → file + Redis IG key)', {
      deviceId,
      userId: mongoUserId || '(none)',
      instagramFromSocial: Boolean(igFromSocial)
    });

    const client = host.getRedisClientOrNull();
    if (!client) return;

    try {
      const deviceMetaKey = `proof.mqtt:device:${deviceId}`;
      if (igFromSocial) {
        await client.set(
          deviceMetaKey,
          JSON.stringify({
            instagramAccountId: igFromSocial.socialAccountId,
            accessToken: igFromSocial.accessToken,
            tokenExpiresAt: igFromSocial.tokenExp || undefined
          }),
          { EX: 604800 }
        );
      } else {
        await client.del(deviceMetaKey);
      }
    } catch (err: unknown) {
      logger.debug('Redis: failed to sync proof.mqtt:device meta', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  } catch (err: unknown) {
    logger.error('❌ [LIFECYCLE:CACHE] Failed to cache active device', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function handleDeviceRegistration(
  host: BootstrapHost,
  topic: string,
  message: Record<string, unknown>
): Promise<void> {
  const deviceId = extractDeviceIdFromTopic(host, topic);
  if (!deviceId) return;

  const allowed = await host.ensureDeviceProvisioned(deviceId);
  if (!allowed) {
    logger.warn('🔒 Registration rejected: no active certificate for this device_id', { deviceId });
    await sendRegistrationResponse(host, deviceId, false, 'Device not provisioned.', false);
    return;
  }

  logger.info('📱 Device Registration Received', {
    deviceId,
    userId: message.userId || message.user_id,
    deviceType: message.deviceType || message.device_type,
    os: message.os,
    type: message.type
  });

  const pilotBoot = parsePilotBootPayload(message);
  const fwVersion =
    pilotBoot.fwVersion || (message.appVersion as string) || (message.app_version as string);

  const existingDevice = await host.deviceService.getDevice(deviceId);
  if (!existingDevice) {
    await host.deviceService.registerDevice({
      deviceId,
      clientId: deviceId,
      macID: deviceId,
      username: (message.userId as string) || (message.user_id as string) || 'unknown',
      status: 'active',
      lastSeen: new Date(),
      metadata: {
        mqttClientId: message.clientId,
        deviceType: message.deviceType || message.device_type,
        os: message.os,
        appVersion: fwVersion,
        bootType: pilotBoot.bootType,
        ipAddress: pilotBoot.ipAddress,
        registeredAt: new Date().toISOString()
      }
    });
    logger.info('✅ New device registered', { deviceId });
    await sendRegistrationResponse(host, deviceId, true, 'Device registered successfully', true);
  } else {
    if (typeof fwVersion === 'string' && fwVersion.trim()) {
      await Device.updateOne(
        { clientId: deviceId },
        {
          $set: {
            firmwareVersion: fwVersion.trim(),
            firmwareReportedAt: new Date(),
            lastSeenAt: new Date()
          }
        }
      );
    }
    logger.info('✅ Existing device reconnected', { deviceId, fwVersion: fwVersion || undefined });
    await sendRegistrationResponse(host, deviceId, true, 'Device reconnected successfully', false);
  }

  if (host.otaService && typeof fwVersion === 'string' && fwVersion.trim()) {
    void host.otaService
      .maybeRecordImplicitOtaSuccess(deviceId, fwVersion.trim(), pilotBoot.bootType)
      .catch((err: unknown) => {
        logger.warn('[OTA] Implicit success check failed', {
          deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
  }

  void host.influxService
    ?.writeDeviceOtaEvent({
      deviceId,
      event: 'boot',
      sourceTopic: 'active',
      fwVersion: typeof fwVersion === 'string' ? fwVersion : undefined,
      bootType: pilotBoot.bootType,
      ipAddress: pilotBoot.ipAddress,
      timestamp: pilotBoot.timestamp
    })
    .catch(() => undefined);

  logger.info('📋 [LIFECYCLE:REGISTER] Caching device in Redis active list', { deviceId });
  await cacheActiveDevice(host, deviceId);
  await host.redisMarkDeviceActive(deviceId);

  const mongoUserId = (await Device.findOne({ clientId: deviceId }).select({ userId: 1 }).lean())?.userId
    ?.toString();
  const ip = pilotBoot.ipAddress;
  void getDeviceStateLogService()
    .recordTransition({
      deviceId,
      event: 'active',
      fwVersion: typeof fwVersion === 'string' ? fwVersion : undefined,
      ipHash: ip ? crypto.createHash('sha256').update(ip).digest('hex') : undefined,
      userIdAtTime: mongoUserId,
      reason: 'registration'
    })
    .catch(() => undefined);
  if (mongoUserId) {
    void cacheUserIntegrations(mongoUserId).catch((err: unknown) => {
      logger.warn('[LIFECYCLE:REGISTER] Integration cache warm failed', {
        deviceId,
        userId: mongoUserId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  host.deferredWork.enqueueConnectRefresh(deviceId);
  if (host.isServicesReady) {
    void host.processDeferredWork().catch((err: unknown) => {
      logger.error('[DEFERRED_WORK] Failed after registration', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  if (host.stimulateService) {
    void host.stimulateService.resetOnDeviceConnect(deviceId).catch((err: unknown) => {
      logger.warn('[STIM] resetOnDeviceConnect failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  logger.info('📋 [LIFECYCLE:REGISTER] Device registration complete', { deviceId });
  void host.deliverOtaOnRegistration(deviceId, fwVersion);
}

export async function handleDeviceLWT(
  host: BootstrapHost,
  topic: string,
  message: Record<string, unknown>
): Promise<void> {
  const deviceId = extractDeviceIdFromTopic(host, topic);
  if (!deviceId) {
    logger.warn('⚠️ LWT message received but could not extract deviceId', { topic });
    return;
  }

  if (message.type !== 'un_registration') {
    logger.warn('⚠️ Invalid LWT message type', {
      deviceId,
      type: message.type,
      expected: 'un_registration'
    });
    return;
  }

  if (!message.clientId) {
    logger.warn('⚠️ LWT message missing clientId', { deviceId });
    return;
  }

  logger.info('💀 LWT: Device Disconnected (Broker-Generated)', {
    deviceId,
    clientId: message.clientId,
    topic: '/lwt',
    reason: 'Client disconnected (all types: graceful, crash, power cut, etc.)',
    source: 'broker',
    mechanism: 'Last Will and Testament'
  });

  logger.info('💀 [LIFECYCLE:LWT] Removing device from Redis active cache', { deviceId });
  const removed = await host.activeDeviceCache.removeActive(deviceId);
  await host.redisRemoveDevice(deviceId);

  void getDeviceStateLogService()
    .recordTransition({
      deviceId,
      event: 'inactive',
      reason: 'lwt'
    })
    .catch(() => undefined);

  const clearedPublishHashes = await clearAllPublishHashesForDevice(deviceId);
  getLocalPromoRotationCache().clear(deviceId);
  if (clearedPublishHashes > 0) {
    logger.info('💀 [LIFECYCLE:LWT] Cleared MQTT publish dedupe hashes', {
      deviceId,
      clearedPublishHashes
    });
  }

  if (host.stimulateService) {
    void host.stimulateService.stopOnDeviceDisconnect(deviceId).catch((err: unknown) => {
      logger.warn('[STIM] stopOnDeviceDisconnect failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  logger.info('💀 [LIFECYCLE:LWT] Device disconnect processed', {
    deviceId,
    removedFromRedis: removed
  });

  try {
    if (host.redisService?.isRedisConnected()) {
      const client = host.redisService.getClient();
      const multi = client.multi();
      multi.zRem(REDIS_KEYS.priorityZset, deviceId);
      multi.del(REDIS_KEYS.deviceFetchHistory(deviceId));
      multi.del(REDIS_KEYS.deviceFollowers(deviceId));
      multi.del(`instagram:pending:${deviceId}`);
      await multi.exec();
    }
  } catch (err: unknown) {
    logger.warn('Failed to cleanup Instagram polling keys on LWT', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function handleDeviceStatus(
  host: BootstrapHost,
  topic: string,
  message: Record<string, unknown>
): Promise<void> {
  const deviceId = extractDeviceIdFromTopic(host, topic);
  if (!deviceId) return;

  const allowed = await host.ensureDeviceProvisioned(deviceId);
  if (!allowed) {
    logger.warn('🔒 Status update ignored: device not provisioned', { deviceId });
    return;
  }

  const eventType = normalizeOtaEventKey(message);

  if (host.otaEventHandler && isPilotOtaStatusEvent(eventType)) {
    await host.otaEventHandler.handle(deviceId, message);
  }

  if (eventType && host.influxService) {
    void host.influxService.writeOtaTelemetry({
      deviceId,
      event: String(eventType),
      timestamp: message.timestamp as string | undefined,
      current_version: (message.current_version || message.fw_version) as string | undefined,
      target_version: message.target_version as string | undefined,
      from_version: message.from_version as string | undefined,
      to_version: message.to_version as string | undefined,
      attempted_version: message.attempted_version as string | undefined,
      reverted_to: message.reverted_to as string | undefined,
      fw_version: message.fw_version as string | undefined,
      reason: message.reason as string | undefined,
      error_code: message.error_code as string | undefined,
      error_message: message.error_message as string | undefined,
      partition: message.partition as string | undefined,
      boot_reason: message.boot_reason as string | undefined,
      uptime_s: (message.uptime_s ?? message.uptime) as number | undefined,
      free_heap: message.free_heap as number | undefined,
      battery: message.battery as number | undefined,
      signal_strength: message.signal_strength as number | undefined,
      ota_state: message.ota_state as string | undefined,
      checks_passed: message.checks_passed as number | undefined,
      checks_total: message.checks_total as number | undefined,
      attempt_number: message.attempt_number as number | undefined,
      attempt_count: message.attempt_count as number | undefined,
      sha256_match: message.sha256_match as boolean | undefined,
      signature_valid: message.signature_valid as boolean | undefined,
      time_sync_ok: message.time_sync_ok as boolean | undefined,
      download_duration_ms: message.download_duration_ms as number | undefined,
      validation_duration_ms: message.validation_duration_ms as number | undefined,
      firmware_size: message.firmware_size as number | undefined,
      cooldown_remaining_s: message.cooldown_remaining_s as number | undefined,
      source_topic: 'status'
    }).catch(() => undefined);
  }

  logger.info('📊 Device Status Update', {
    deviceId,
    status: message.status,
    eventType,
    uptime: message.uptime
  });
}

export async function handleDeviceOtaTelemetry(
  host: BootstrapHost,
  topic: string,
  message: Record<string, unknown>
): Promise<void> {
  const deviceId = extractDeviceIdFromTopic(host, topic);
  if (!deviceId) return;

  const allowed = await host.ensureDeviceProvisioned(deviceId);
  if (!allowed) {
    logger.warn('🔒 OTA telemetry ignored: device not provisioned', { deviceId });
    return;
  }

  const eventType = message?.ota_status || message?.event || message?.type || 'telemetry';

  if (host.otaEventHandler && String(eventType).startsWith('ota_')) {
    await host.otaEventHandler.handle(deviceId, message);
  }

  if (host.influxService) {
    void host.influxService.writeOtaTelemetry({
      deviceId,
      event: String(eventType),
      timestamp: message.timestamp as string | undefined,
      current_version: (message.current_version || message.fw_version) as string | undefined,
      target_version: message.target_version as string | undefined,
      from_version: message.from_version as string | undefined,
      to_version: message.to_version as string | undefined,
      offered_version: message.offered_version as string | undefined,
      attempted_version: message.attempted_version as string | undefined,
      reverted_to: message.reverted_to as string | undefined,
      fw_version: message.fw_version as string | undefined,
      ota_progress_pct: (message.ota_progress_pct ?? message.progress) as number | undefined,
      ota_bytes: message.ota_bytes as number | undefined,
      ota_bytes_total: message.ota_bytes_total as number | undefined,
      elapsed_ms: message.elapsed_ms as number | undefined,
      estimated_remaining_ms: message.estimated_remaining_ms as number | undefined,
      download_duration_ms: message.download_duration_ms as number | undefined,
      validation_duration_ms: message.validation_duration_ms as number | undefined,
      reason: message.reason as string | undefined,
      error_code: message.error_code as string | undefined,
      error_message: message.error_message as string | undefined,
      http_code: message.http_code as number | undefined,
      expected_sha256: message.expected_sha256 as string | undefined,
      computed_sha256: message.computed_sha256 as string | undefined,
      uptime_s: (message.uptime_s ?? message.uptime) as number | undefined,
      free_heap: message.free_heap as number | undefined,
      battery: message.battery as number | undefined,
      signal_strength: message.signal_strength as number | undefined,
      wifi_rssi: message.wifi_rssi as number | undefined,
      cert_days_remaining: message.cert_days_remaining as number | undefined,
      cert_renewal_needed: message.cert_renewal_needed as boolean | undefined,
      partition: message.partition as string | undefined,
      boot_reason: message.boot_reason as string | undefined,
      ota_state: message.ota_state as string | undefined,
      checks_passed: message.checks_passed as number | undefined,
      checks_total: message.checks_total as number | undefined,
      attempt_number: message.attempt_number as number | undefined,
      attempt_count: message.attempt_count as number | undefined,
      firmware_size: (message.firmware_size ?? message.firmwareSize ?? message.sizeBytes) as number | undefined,
      cooldown_remaining_s: message.cooldown_remaining_s as number | undefined,
      sha256_match: message.sha256_match as boolean | undefined,
      signature_valid: message.signature_valid as boolean | undefined,
      time_sync_ok: message.time_sync_ok as boolean | undefined,
      source_topic: 'telemetry'
    }).catch(() => undefined);
  }

  logger.info('📊 OTA Telemetry', {
    deviceId,
    event: eventType,
    progress: message.ota_progress_pct ?? message.progress,
    free_heap: message.free_heap,
    uptime: message.uptime_s ?? message.uptime
  });
}
