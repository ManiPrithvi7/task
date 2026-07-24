import * as fs from 'fs';
import type { BootstrapHost } from './bootstrapHost';
import { fanOutTestOtaToActiveDevices } from './otaRegistrationCoordinator';
import { createFirmwareStorageService } from '../services/firmwareStorageService';
import { resolveOtaPublicBaseUrl } from '../config/otaDefaults';
import {
  initOtaSigningState,
  OtaService,
  OtaCommandPublisher,
  OtaEventHandler,
  OtaRedisState
} from '../services/otaService';
import { backfillFirmwareReleaseStageFields } from '../models/FirmwareRelease';
import { startRolloutScheduler } from '../jobs/rolloutScheduler';
import { initOtaSigningKeyAudit } from '../services/otaSigningKeyService';
import { createOtaReleaseLog } from '../services/otaReleaseLog';
import { logger } from '../utils/logger';

export function initializeOtaServices(host: BootstrapHost): void {
  if (!host.config.ota?.enabled) return;

  host.firmwareStorageService = createFirmwareStorageService(host.config.ota);
  initOtaSigningState(host.config.ota.signingConfirmed);
  if (host.config.ota.signingPublicKeyPem) {
    initOtaSigningKeyAudit(host.config.ota.signingPublicKeyPem, 'env');
  } else if (host.config.ota.signingPublicKeyPath) {
    try {
      const pem = fs.readFileSync(host.config.ota.signingPublicKeyPath, 'utf8');
      initOtaSigningKeyAudit(pem, 'file');
    } catch {
      /* key file audit best-effort */
    }
  }
  void host.firmwareStorageService
    .verifyBucketAccess()
    .catch((err: unknown) => {
      logger.error('[OTA] OCI bucket access check failed', {
        bucket: host.config.ota?.oci.bucket,
        namespace: host.config.ota?.oci.namespace,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  host.otaPublicBaseUrl = resolveOtaPublicBaseUrl({
    otaPublicBaseUrl: process.env.OTA_PUBLIC_BASE_URL,
    publicAppUrl: process.env.PUBLIC_APP_URL,
    httpHost: host.config.http.host,
    httpPort: host.config.http.port
  });

  host.otaRedisState = new OtaRedisState(
    () => host.getRedisClientOrNull(),
    host.config.redis.keyPrefix || 'proof-mqtt:'
  );
  host.otaCommandPublisher = new OtaCommandPublisher(
    host.mqttClient,
    host.config.mqtt.topicRoot,
    host.config.ota.broadcastTopic,
    host.otaRedisState,
    host.config.ota
  );
  host.otaService = new OtaService(
    host.config.ota,
    host.firmwareStorageService,
    host.otaPublicBaseUrl,
    host.otaCommandPublisher,
    host.otaRedisState
  );
  host.otaEventHandler = new OtaEventHandler(host.otaService, host.otaCommandPublisher);

  void backfillFirmwareReleaseStageFields()
    .then((n) => {
      if (n > 0) logger.info('[OTA] Backfilled FirmwareRelease stage fields', { modified: n });
    })
    .catch((err: unknown) => {
      logger.warn('[OTA] Stage field backfill failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err)
      });
    });

  if (host.otaRedisState) {
    host.otaRolloutScheduler = startRolloutScheduler({
      otaService: host.otaService,
      otaRedisState: host.otaRedisState,
      otaConfig: host.config.ota
    });
  }

  const otaReleaseLog = createOtaReleaseLog();
  void otaReleaseLog.initialize().catch((err: unknown) => {
    logger.warn('[OTA] Release log initialization failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err)
    });
  });

  logger.info('✅ OTA services initialized', {
    mqttDownloadMode: 'presigned',
    httpDownloadMode: host.config.ota.downloadMode,
    publicBaseUrl: host.otaPublicBaseUrl,
    bucket: host.config.ota.oci.bucket,
    namespace: host.config.ota.oci.namespace,
    delivery: 'server-driven',
    testOta: process.env.TEST_OTA === 'true'
  });
  if (host.config.ota.downloadMode === 'proxy') {
    logger.warn(
      '[OTA] OTA_DOWNLOAD_MODE=proxy enables GET /api/v1/ota/download only — requires mTLS-capable HTTP edge (not Railway public URL). MQTT always uses OCI presigned PAR.'
    );
  }

  if (process.env.TEST_OTA === 'true') {
    void fanOutTestOtaToActiveDevices({
      config: host.config,
      otaService: host.otaService,
      otaCommandPublisher: host.otaCommandPublisher,
      otaPublicBaseUrl: host.otaPublicBaseUrl
    }).catch((err: unknown) => {
      logger.warn('[OTA] TEST_OTA startup fan-out failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }
}
