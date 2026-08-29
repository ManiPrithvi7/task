import mongoose from 'mongoose';
import crypto from 'crypto';
import type { BootstrapHost } from './bootstrapHost';
import type { ActiveDevice } from '../services/deviceService';
import { Device } from '../models/Device';
import { clearAllPublishHashesForDevice } from '../services/mqttChangeDetection';
import { getLocalPromoRotationCache } from '../services/localCaches';
import { cacheUserIntegrations } from '../services/userIntegrationCache';
import { getDeviceStateLogService } from '../services/deviceStateLogService';
import { REDIS_KEYS } from '../constants/redisKeys';
import { writeDeviceHashOnConnect } from '../services/igDeviceRuntimeCache';
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
        businessId: '',
        lastSeen: Date.now()
      });
      return;
    }

    logger.info('📋 [LIFECYCLE:CACHE] Step 2/2 — Social (Instagram) for device', {
      deviceId,
      businessId: deviceDoc.businessId?.toString() || 'none',
      deviceStatus: deviceDoc.status
    });

    const mongoUserId = deviceDoc.businessId?.toString() || '';
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
      businessId: mongoUserId,
      lastSeen: Date.now(),
      ...(igFromSocial
        ? { instagramAccountId: igFromSocial.socialAccountId, accessToken: igFromSocial.accessToken }
        : {})
    };

    await host.activeDeviceCache.setActive(active);

    logger.info('📋 [LIFECYCLE:CACHE] Active device record written (Mongo → file + Redis device hash)', {
      deviceId,
      userId: mongoUserId || '(none)',
      instagramFromSocial: Boolean(igFromSocial)
    });

    const hashFields: Record<string, string> = { status: 'active' };
    if (mongoUserId) hashFields.business_id = mongoUserId;
    const registeredAt = (deviceDoc.provisionedAt ?? deviceDoc.createdAt)?.getTime?.();
    if (registeredAt && !Number.isNaN(registeredAt)) {
      hashFields.registered_at = String(registeredAt);
    }
    if (igFromSocial) {
      hashFields.ig_accountId = igFromSocial.socialAccountId;
      hashFields.ig_accessToken = igFromSocial.accessToken;
    }
    await writeDeviceHashOnConnect(deviceId, hashFields);
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
    ?.writeOtaEvent({
      deviceId,
      event: 'boot',
      source: 'active',
      fwVersion: typeof fwVersion === 'string' ? fwVersion : undefined,
      ipAddress: pilotBoot.ipAddress,
      timestamp: pilotBoot.timestamp
    })
    .catch(() => undefined);

  logger.info('📋 [LIFECYCLE:REGISTER] Caching device in Redis active list', { deviceId });
  await cacheActiveDevice(host, deviceId);
  await host.redisMarkDeviceActive(deviceId);

  const mongoBusinessId = (await Device.findOne({ clientId: deviceId }).select({ businessId: 1 }).lean())?.businessId
    ?.toString();
  const ip = pilotBoot.ipAddress;
  void getDeviceStateLogService()
    .recordTransition({
      deviceId,
      event: 'active',
      fwVersion: typeof fwVersion === 'string' ? fwVersion : undefined,
      ipHash: ip ? crypto.createHash('sha256').update(ip).digest('hex') : undefined,
      businessIdAtTime: mongoBusinessId,
      reason: 'registration'
    })
    .catch(() => undefined);
  if (mongoBusinessId) {
    void cacheUserIntegrations(mongoBusinessId).catch((err: unknown) => {
      logger.warn('[LIFECYCLE:REGISTER] Integration cache warm failed', {
        deviceId,
        businessId: mongoBusinessId,
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
      host.instagramPoller?.notifyPriorityQueueMemberRemoved(deviceId);
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
    void host.influxService.writeOtaEvent({
      deviceId,
      event: String(eventType),
      source: 'status',
      timestamp: message.timestamp as string | undefined,
      fwVersion: (message.current_version || message.fw_version) as string | undefined,
      fromVersion: message.from_version as string | undefined,
      errorMessage: message.error_message as string | undefined,
      errorCode: message.error_code as string | undefined,
      attemptNumber: (message.attempt_number ?? message.attempt_count) as number | undefined,
      sha256Match: message.sha256_match as boolean | undefined,
      signatureValid: message.signature_valid as boolean | undefined
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
    void host.influxService.writeOtaEvent({
      deviceId,
      event: String(eventType),
      source: 'telemetry',
      timestamp: message.timestamp as string | undefined,
      fwVersion: (message.current_version || message.fw_version) as string | undefined,
      fromVersion: message.from_version as string | undefined,
      otaBytes: message.ota_bytes as number | undefined,
      errorMessage: (message.error_message || message.reason) as string | undefined,
      errorCode: message.error_code as string | undefined,
      certDaysRemaining: message.cert_days_remaining as number | undefined,
      certRenewalNeeded: message.cert_renewal_needed as boolean | undefined,
      attemptNumber: (message.attempt_number ?? message.attempt_count) as number | undefined,
      sha256Match: message.sha256_match as boolean | undefined,
      signatureValid: message.signature_valid as boolean | undefined
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
