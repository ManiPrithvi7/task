import * as path from 'path';
import type { BootstrapHost } from './bootstrapHost';
import { initializeHttpServer } from './httpRouteRegistry';
import { StatsPublisher } from '../services/statsPublisher';
import { ConnectRefreshCoordinator } from '../services/connectRefreshCoordinator';
import { GmbConnectPull } from '../services/gmbConnectPull';
import { StimulateService } from '../services/stimulateService';
import { createConnectionsRoutes } from '../routes/connectionsRoutes';
import {
  InstagramServerlessBridge,
  InstagramDirectFetchInvoker,
  InstagramPoller,
  type InstagramFetchInvoker
} from '../services/instagramService';
import { registerIgIntegrationLifecycle } from '../services/igIntegrationLifecycle';
import { createInfluxService, resetInfluxService } from '../services/influxService';
import { createAuditService } from '../services/auditService';
import { createTransparencyLog } from '../services/transparencyLog';
import { createDeviceStateLogService } from '../services/deviceStateLogService';
import { logger } from '../utils/logger';

export async function initializePhase2(host: BootstrapHost): Promise<void> {
  logger.info('📈 Initializing InfluxDB...');
  await initializeInfluxDB(host);
  await initializePkiGovernance(host);

  const deviceStateLog = createDeviceStateLogService();
  await deviceStateLog.initialize();

  if (host.config.provisioning.enabled && !host.caService) {
    await host.initializeProvisioning();
  }

  await initializeInstagramPoller(host);
  await initializeHttpServer(host);
  await initializeStatsPublisher(host);
  initializeConnectRefreshCoordinator(host);
  await initializeStimulateService(host);
  initializeKeepAlive(host);

  host.isServicesReady = true;
  host.mqttIngressState.isServicesReady = true;
  logger.info('🟢 All services ready — draining deferred work and message buffer');

  await host.processDeferredWork();
  await host.flushMqttMessageBuffer();
  logSubsystemSummary(host);
}

function logSubsystemSummary(host: BootstrapHost): void {
  logger.info('📋 Enabled subsystems', {
    ota: host.config.ota?.enabled === true,
    instagramPoller: Boolean(host.instagramPoller),
    gmbWebhooks: Boolean(
      host.config.webhooks.gmbPubsubAudience ||
        host.config.webhooks.gmbPubsubSkipAuthVerify ||
        host.config.webhooks.mqttPublishEnabled
    ),
    stimulate: Boolean(process.env.STIMULATE_DEVICE?.trim()),
    provisioning: host.config.provisioning.enabled,
    testOta: process.env.TEST_OTA === 'true'
  });
}

async function initializeInfluxDB(host: BootstrapHost): Promise<void> {
  try {
    host.influxService = createInfluxService(host.config.influxdb);
    const healthy = await host.influxService.healthCheck();

    if (!healthy) {
      await resetInfluxService();
      host.influxService = undefined;
      throw new Error(
        'InfluxDB unreachable or misconfigured. Verify INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG, INFLUXDB_BUCKET, INFLUXDB_COMPLIANCE_BUCKET.'
      );
    }

    logger.info('📈 InfluxDB connected', {
      url: host.config.influxdb.url,
      org: host.config.influxdb.org,
      bucket: host.config.influxdb.bucket,
      complianceBucket: host.config.influxdb.complianceBucket,
      diskQueue: host.config.influxdb.diskQueueEnabled,
      diskQueueSync: host.config.influxdb.diskQueueSyncOnAppend
    });
  } catch (err: unknown) {
    await resetInfluxService();
    host.influxService = undefined;
    throw err;
  }
}

async function initializePkiGovernance(host: BootstrapHost): Promise<void> {
  if (!host.config.provisioning.auditLogEnabled) {
    logger.info('PKI audit log disabled (PKI_AUDIT_LOG_ENABLED=false)');
    return;
  }

  const fallbackLogPath = path.join(host.config.provisioning.caStoragePath, 'audit.log');

  host.auditService = createAuditService({ fallbackLogPath });
  await host.auditService.initialize();
  logger.info('PKI AuditService initialized (hash-chain)');

  if (!host.config.provisioning.transparencyLogEnabled) {
    logger.info('PKI transparency log disabled (TRANSPARENCY_LOG_ENABLED=false)');
    return;
  }

  if (!host.influxService) {
    logger.warn(
      'TRANSPARENCY_LOG_ENABLED=true but InfluxDB unavailable — CT log disabled (audit log still active via file fallback)'
    );
    return;
  }

  host.transparencyLog = createTransparencyLog({ enabled: true });
  await host.transparencyLog.initialize();
  logger.info('PKI TransparencyLog initialized (Merkle tree → Influx ct_log)');
}

async function initializeInstagramPoller(host: BootstrapHost): Promise<void> {
  if (!host.redisService?.isRedisConnected()) {
    logger.info('📉 Instagram poller disabled (Redis not connected)');
    return;
  }

  const igPoll = host.config.instagramPolling!;
  const sl = host.config.instagramServerless;
  const fetchUrl = sl?.fetchUrl?.trim();

  let fetchInvoker: InstagramFetchInvoker;
  if (fetchUrl) {
    host.instagramServerlessBridge = new InstagramServerlessBridge(sl!, host.mqttClient);
    fetchInvoker = host.instagramServerlessBridge;
    logger.info('📡 Instagram fetch mode: serverless (INSTAGRAM_SERVERLESS_URL set)');
  } else {
    host.instagramServerlessBridge = undefined;
    fetchInvoker = new InstagramDirectFetchInvoker(host.mqttClient);
    logger.info(
      '📡 Instagram fetch mode: direct (Graph API on this server). Set INSTAGRAM_SERVERLESS_URL to offload to a worker.'
    );
  }

  host.instagramPoller = new InstagramPoller(fetchInvoker, host.redisService, {
    priorityIntervalMs: igPoll.priorityIntervalMs,
    backgroundIntervalMs: igPoll.backgroundIntervalMs,
    priorityTtlMs: igPoll.priorityTtlMs,
    batchSize: igPoll.batchSize,
    backoffThreshold: igPoll.backoffThreshold,
    backoffWindowMs: igPoll.backoffWindowMs,
    priorityCapPerCycle: igPoll.priorityCapPerCycle,
    fetchDedupeWindowMs: igPoll.fetchDedupeWindowMs,
    priorityZsetMaxMembers: igPoll.priorityZsetMaxMembers,
    priorityRefreshMaxDeltaMs: igPoll.priorityRefreshMaxDeltaMs,
    priorityAbsoluteMaxFutureMs: igPoll.priorityAbsoluteMaxFutureMs,
    backgroundCapPerCycle: igPoll.backgroundCapPerCycle,
    backgroundFairRotate: igPoll.backgroundFairRotate,
    globalFetchBudgetPerMinute: igPoll.globalFetchBudgetPerMinute,
    useLocalCircuit: igPoll.useLocalCircuit,
    useLocalBackoff: igPoll.useLocalBackoff,
    useLocalBudget: igPoll.useLocalBudget,
    useLocalDedupe: igPoll.useLocalDedupe,
    useLocalFairOffset: igPoll.useLocalFairOffset
  });

  await host.instagramPoller.start();
  registerIgIntegrationLifecycle({
    instagramPoller: host.instagramPoller,
    instagramPriorityTtlMs: igPoll.priorityTtlMs
  });
  logger.info('✅ Instagram poller initialized (dual schedulers enabled)');
}

async function initializeStatsPublisher(host: BootstrapHost): Promise<void> {
  logger.info('📊 Initializing stats publisher...');

  host.statsPublisher = new StatsPublisher(
    host.mqttClient,
    host.deviceService,
    60 * 1000,
    host.caService,
    host.config.provisioning.requireMtlsForRegistration
  );

  await host.statsPublisher.start();

  if (host.httpServer) {
    const routeDeps = {
      statsPublisher: host.statsPublisher,
      topicRoot: host.config.mqtt.topicRoot
    };
    host.httpServer.getApp().use('/api/v1', createConnectionsRoutes(routeDeps));
    logger.info('✅ Connections routes registered at POST /api/v1/connections/validate');
  }

  logger.info('✅ Stats publisher initialized - publishing every 60s to /instagram, /gmb, /promotion');
}

function initializeConnectRefreshCoordinator(host: BootstrapHost): void {
  const gmbConnectPull = new GmbConnectPull(
    host.mqttClient,
    host.config.webhooks.mqttPublishEnabled,
    host.config.webhooks
  );
  host.connectRefreshCoordinator = new ConnectRefreshCoordinator({
    mqttClient: host.mqttClient,
    redisService: host.redisService ?? null,
    instagramPoller: host.instagramPoller ?? null,
    instagramPriorityTtlMs: host.config.instagramPolling?.priorityTtlMs ?? 300_000,
    gmbConnectPull,
    statsPublisher: host.statsPublisher!
  });
  logger.info('✅ Connect refresh coordinator initialized (/active → debounced screen pull)');
}

async function initializeStimulateService(host: BootstrapHost): Promise<void> {
  if (!host.mqttClient) {
    logger.warn('[STIM] MQTT client missing — skip stimulate service');
    return;
  }
  host.stimulateService = new StimulateService();
  await host.stimulateService.start(
    host.mqttClient,
    host.redisService ?? null,
    host.config.mqtt.topicRoot,
    host.config.webhooks.mqttPublishEnabled
  );
}

function initializeKeepAlive(host: BootstrapHost): void {
  if (process.env.ENABLE_SELF_KEEPALIVE !== 'true') {
    return;
  }

  const keepAliveInterval = 10 * 60 * 1000;

  host.keepAliveTimer = setInterval(() => {
    const url = `http://127.0.0.1:${host.config.http.port}/health`;
    fetch(url)
      .then((res) => {
        logger.debug('Keep-alive ping sent', {
          status: res.status,
          interval: '10min'
        });
      })
      .catch((err: unknown) => {
        logger.debug('Keep-alive ping failed (normal if external monitoring exists)', {
          error: err instanceof Error ? err.message : String(err)
        });
      });
  }, keepAliveInterval);

  logger.info('Keep-alive enabled', { interval: '10 minutes' });
}
