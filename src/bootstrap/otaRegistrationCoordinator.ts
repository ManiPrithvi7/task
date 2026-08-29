import type { AppConfig } from '../config';
import { buildOtaProxyDownloadUrl, resolveOtaPublicBaseUrl } from '../config/otaDefaults';
import { DeviceOtaState } from '../models/DeviceOtaState';
import type { DeferredDeviceWorkQueue } from '../services/deferredDeviceWork';
import type { OtaCommandPublisher, OtaService } from '../services/otaService';
import { getActiveDeviceCache } from '../services/deviceService';
import { logger } from '../utils/logger';
import { resolveLocalTestOtaFirmware } from '../utils/localTestOtaFirmware';

export interface OtaRegistrationCoordinatorDeps {
  config: AppConfig;
  otaService?: OtaService;
  otaCommandPublisher?: OtaCommandPublisher;
  otaPublicBaseUrl?: string;
  deferredWork?: DeferredDeviceWorkQueue;
  isServicesReady?: boolean;
  processDeferredWork?: () => Promise<void>;
}

export function buildTestOtaDownloadUrl(deps: OtaRegistrationCoordinatorDeps): string {
  return buildOtaProxyDownloadUrl(
    deps.otaPublicBaseUrl ??
      resolveOtaPublicBaseUrl({
        otaPublicBaseUrl: process.env.OTA_PUBLIC_BASE_URL,
        publicAppUrl: process.env.PUBLIC_APP_URL,
        httpHost: deps.config.http.host,
        httpPort: deps.config.http.port
      }),
    'proof:1.0.1'
  );
}

/** TEST_OTA: forced proof:1.0.1 proxy offer — no version / eligibility / rollout gates. */
export async function publishTestOtaToDevice(
  deps: OtaRegistrationCoordinatorDeps,
  deviceId: string,
  reason: 'registration' | 'active_cache_fanout'
): Promise<boolean> {
  if (!deps.otaService || !deps.otaCommandPublisher) return false;

  const baseOffer = await deps.otaService.getLatestStableOfferUngated();
  if (!baseOffer) {
    logger.warn('[OTA] TEST_OTA — no STABLE release to build offer from', { deviceId, reason });
    return false;
  }

  const localFw = resolveLocalTestOtaFirmware();
  if (!localFw) {
    logger.warn('[OTA] TEST_OTA — no firmware .bin found in data/', { deviceId, reason });
    return false;
  }

  const toPublish = {
    ...baseOffer,
    version: '1.0.1',
    downloadUrl: buildTestOtaDownloadUrl(deps),
    sizeBytes: localFw.sizeBytes
  };
  logger.info('[OTA] TEST_OTA — ungated publish proof:1.0.1', {
    deviceId,
    reason,
    version: toPublish.version,
    downloadUrl: toPublish.downloadUrl,
    sizeBytes: toPublish.sizeBytes,
    firmwareFile: localFw.filename,
    releaseVersion: baseOffer.version
  });
  await deps.otaCommandPublisher.publishUpdateToDevice(deviceId, toPublish, false);
  return true;
}

export async function fanOutTestOtaToActiveDevices(deps: OtaRegistrationCoordinatorDeps): Promise<void> {
  const devices = await getActiveDeviceCache().getAllActive();
  let pushed = 0;
  for (const d of devices) {
    try {
      if (await publishTestOtaToDevice(deps, d.deviceId, 'active_cache_fanout')) {
        pushed += 1;
      }
    } catch (err: unknown) {
      logger.warn('[OTA] TEST_OTA fan-out failed for device', {
        deviceId: d.deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  logger.info('[OTA] TEST_OTA — fan-out complete', { pushed, total: devices.length });
}

export async function executeOtaRegistrationDelivery(
  deps: OtaRegistrationCoordinatorDeps,
  deviceId: string,
  currentVersion: string
): Promise<void> {
  if (!deps.config.ota?.enabled || !deps.otaService) {
    return;
  }

  try {
    await deps.otaService.deliverPendingToDevice(deviceId, currentVersion);

    const offer = await deps.otaService.resolveUpdate({ deviceId, currentVersion });
    if (offer && deps.otaCommandPublisher) {
      await deps.otaCommandPublisher.publishUpdateToDevice(deviceId, offer, false);
    }
  } catch (err: unknown) {
    logger.warn('[OTA] Registration delivery failed', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function deliverOtaOnRegistration(
  deps: OtaRegistrationCoordinatorDeps,
  deviceId: string,
  appVersion?: string
): Promise<void> {
  if (!deps.config.ota?.enabled || !deps.otaService) {
    return;
  }

  if (process.env.TEST_OTA === 'true') {
    try {
      await publishTestOtaToDevice(deps, deviceId, 'registration');
    } catch (err: unknown) {
      logger.warn('[OTA] TEST_OTA registration delivery failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return;
  }

  let currentVersion =
    typeof appVersion === 'string' && appVersion.trim() ? appVersion.trim() : undefined;

  if (!currentVersion || currentVersion === '1.0.0') {
    const otaState = await DeviceOtaState.findOne({ deviceId })
      .select({ firmwareVersion: 1 })
      .lean();
    if (otaState?.firmwareVersion?.trim()) {
      currentVersion = otaState.firmwareVersion.trim();
    }
  }

  if (!currentVersion) {
    logger.warn('[OTA] Skipping registration OTA — no currentVersion', {
      deviceId,
      appVersion: appVersion || null
    });
    return;
  }

  if (deps.deferredWork) {
    deps.deferredWork.enqueueOtaRegistration(deviceId, currentVersion);
    if (deps.isServicesReady && deps.processDeferredWork) {
      void deps.processDeferredWork().catch((err: unknown) => {
        logger.error('[DEFERRED_WORK] Failed after OTA registration enqueue', {
          deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }
    return;
  }

  await executeOtaRegistrationDelivery(deps, deviceId, currentVersion);
}
