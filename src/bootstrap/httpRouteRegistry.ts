import type { BootstrapHost } from './bootstrapHost';
import { initializeOtaServices } from './otaServiceBootstrap';
import { HttpServer } from '../servers/httpServer';
import { AuthService } from '../services/authService';
import { createProvisioningRoutes } from '../routes/provisioningRoutes';
import { createConfigRoutes } from '../routes/configRoutes';
import { createLifecycleRoutes } from '../routes/lifecycleRoutes';
import { createRecoveryRoutes } from '../routes/recoveryRoutes';
import { createOtaRoutes } from '../routes/otaRoutes';
import { createOtaAdminRoutes } from '../routes/otaAdminRoutes';
import { createWebhookRoutes, type OtaReleaseWebhookDeps } from '../routes/webhookRoutes';
import { createDashboardRoutes } from '../routes/dashboardRoutes';
import { createIntegrationRoutes } from '../routes/integrationRoutes';
import { createInstagramMetricsRoutes } from '../routes/instagramMetricsRoutes';
import { createInfluxQueryRoutes } from '../routes/influxQueryRoutes';
import { createRecoverySessionService } from '../services/recoverySessionService';
import { logger } from '../utils/logger';

export async function initializeHttpServer(host: BootstrapHost): Promise<void> {
  logger.info('🌐 Initializing HTTP server...');

  let otaReleaseWebhook: OtaReleaseWebhookDeps | undefined;

  if (host.config.ota?.enabled) {
    initializeOtaServices(host);
    if (host.config.ota.releaseWebhookSecret && host.otaService) {
      otaReleaseWebhook = {
        secret: host.config.ota.releaseWebhookSecret,
        otaService: host.otaService
      };
    }
  }

  const webhookRoutes = createWebhookRoutes({
    mqttClient: host.mqttClient,
    topicRoot: host.config.mqtt.topicRoot,
    webhookConfig: host.config.webhooks,
    appEnv: host.config.app.env,
    otaReleaseWebhook
  });

  host.httpServer = new HttpServer(
    host.config.http,
    host.sessionService,
    host.deviceService,
    host.mqttClient,
    () => host.buildReadinessPayload(),
    [webhookRoutes]
  );

  if (
    host.config.provisioning.enabled &&
    host.provisioningService &&
    host.caService &&
    host.authService &&
    host.userService
  ) {
    const provisioningRoutes = createProvisioningRoutes({
      provisioningService: host.provisioningService,
      caService: host.caService,
      authService: host.authService,
      userService: host.userService
    });
    host.httpServer.getApp().use('/api/v1', provisioningRoutes);
    logger.info('✅ Provisioning routes registered at /api/v1');

    const recoverySessionService = createRecoverySessionService(
      host.config.redis.keyPrefix || 'proof-mqtt:',
      host.config.auth.secret
    );

    const lifecycleRoutes = createLifecycleRoutes({
      caService: host.caService,
      recoverySessionService
    });
    host.httpServer.getApp().use('/api/v1', lifecycleRoutes);
    logger.info('✅ Lifecycle routes registered at /api/v1');

    const recoveryRoutes = createRecoveryRoutes({
      recoverySessionService,
      authService: host.authService
    });
    host.httpServer.getApp().use('/api/v1', recoveryRoutes);
    logger.info('✅ Recovery routes registered at /api/v1/recovery');

    host.httpServer.getApp().use('/api', recoveryRoutes);
    logger.info('✅ Recovery routes registered at /api/recovery (alias)');
  }

  try {
    const configRoutes = createConfigRoutes({
      config: host.config,
      caService: host.caService
    });
    host.httpServer.getApp().use('/api/v1', configRoutes);
    logger.info('✅ Device configuration route registered at /api/v1/mqtt-config');
  } catch (err: unknown) {
    logger.warn('⚠️ Failed to register device configuration route', {
      error: err instanceof Error ? err.message : String(err)
    });
  }

  if (host.config.ota?.enabled) {
    if (
      host.firmwareStorageService &&
      host.otaService &&
      host.otaCommandPublisher &&
      host.otaEventHandler
    ) {
      const publicBaseUrl = host.otaPublicBaseUrl!;

      const otaRoutes = createOtaRoutes({
        otaConfig: host.config.ota,
        otaService: host.otaService,
        storage: host.firmwareStorageService,
        eventHandler: host.otaEventHandler,
        getRedisClient: () => host.getRedisClientOrNull(),
        redisKeyPrefix: host.config.redis.keyPrefix || 'proof-mqtt:'
      });
      host.httpServer.getApp().use('/api/v1', otaRoutes);
      logger.info('✅ OTA device routes registered at /api/v1/ota/*');

      if (host.authService || host.config.auth.secret) {
        if (!host.authService && host.config.auth.secret) {
          host.authService = new AuthService(host.config.auth.secret);
        }
        const adminAuth = host.authService!;
        const otaAdminRoutes = createOtaAdminRoutes({
          otaConfig: host.config.ota,
          authService: adminAuth,
          storage: host.firmwareStorageService,
          otaService: host.otaService,
          commandPublisher: host.otaCommandPublisher,
          publicBaseUrl
        });
        host.httpServer.getApp().use('/api/v1/admin/ota', otaAdminRoutes);
        logger.info('✅ OTA admin routes registered at /api/v1/admin/ota/*');
      } else {
        logger.warn('⚠️ OTA admin routes skipped — AuthService not initialized');
      }
    }
  }

  if (host.influxService) {
    if (host.authService || host.config.auth?.secret) {
      if (!host.authService && host.config.auth?.secret) {
        host.authService = new AuthService(host.config.auth.secret);
      }
      if (host.authService) {
        const dashboardRoutes = createDashboardRoutes({ authService: host.authService });
        host.httpServer.getApp().use('/api/v1', dashboardRoutes);
        logger.info('✅ Dashboard routes registered at /api/v1/dashboard/*');

        const integrationRoutes = createIntegrationRoutes({ authService: host.authService });
        host.httpServer.getApp().use('/api/v1', integrationRoutes);
        logger.info('✅ Integration routes registered at /api/v1/integrations/*');

        const instagramMetricsRoutes = createInstagramMetricsRoutes({ authService: host.authService });
        host.httpServer.getApp().use('/api/v1', instagramMetricsRoutes);
        logger.info('✅ Instagram metrics routes registered at /api/v1/instagram/metrics/*');

        const influxQueryRoutes = createInfluxQueryRoutes({ authService: host.authService });
        host.httpServer.getApp().use('/api/v1', influxQueryRoutes);
        logger.info('✅ Influx query proxy registered at POST /api/v1/influx/query');
      } else {
        logger.warn('⚠️ Dashboard/integration/query routes skipped — AuthService not initialized');
      }
    } else {
      logger.warn('⚠️ Dashboard/integration/query routes skipped — AUTH_SECRET not configured');
    }
  } else {
    logger.info('⏭️ Dashboard/integration/query routes skipped — InfluxDB unavailable');
  }

  await host.httpServer.start();
  logger.info('✅ HTTP server initialized');
}
