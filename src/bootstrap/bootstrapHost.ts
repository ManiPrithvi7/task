import type { AppConfig } from '../config';
import type { HttpServer } from '../servers/httpServer';
import type { MqttClientManager } from '../servers/mqttClient';
import type { SessionService } from '../services/sessionService';
import type { DeviceService, ActiveDeviceCache } from '../services/deviceService';
import type { StatsPublisher } from '../services/statsPublisher';
import type { ConnectRefreshCoordinator } from '../services/connectRefreshCoordinator';
import type { DeferredDeviceWorkQueue } from '../services/deferredDeviceWork';
import type { ProvisioningService } from '../services/provisioningService';
import type { CAService } from '../services/caService';
import type { AuthService } from '../services/authService';
import type { UserService } from '../services/userService';
import type { MongoService } from '../services/mongoService';
import type { RedisService } from '../services/redisService';
import type { InfluxService } from '../services/influxService';
import type { AuditService } from '../services/auditService';
import type { TransparencyLog } from '../services/transparencyLog';
import type { InstagramPoller, InstagramServerlessBridge } from '../services/instagramService';
import type { StimulateService } from '../services/stimulateService';
import type {
  OtaService,
  OtaCommandPublisher,
  OtaEventHandler,
  OtaRedisState
} from '../services/otaService';
import type { FirmwareStorageService } from '../services/firmwareStorageService';
import type { RolloutSchedulerHandle } from '../jobs/rolloutScheduler';
import type { MqttIngressRouterState } from '../services/mqttIngressRouter';
import type { LoyaltyService } from '../services/loyaltyService';

/** Mutable host surface shared by bootstrap modules (StatsMqttLite implements via delegation). */
export interface BootstrapHost {
  config: AppConfig;
  httpServer?: HttpServer;
  mqttClient: MqttClientManager;
  sessionService: SessionService;
  deviceService: DeviceService;
  activeDeviceCache: ActiveDeviceCache;
  statsPublisher?: StatsPublisher;
  connectRefreshCoordinator?: ConnectRefreshCoordinator;
  deferredWork: DeferredDeviceWorkQueue;
  provisioningService?: ProvisioningService;
  caService?: CAService;
  authService?: AuthService;
  userService?: UserService;
  mongoService?: MongoService;
  redisService?: RedisService;
  influxService?: InfluxService;
  auditService?: AuditService;
  transparencyLog?: TransparencyLog;
  instagramServerlessBridge?: InstagramServerlessBridge;
  instagramPoller?: InstagramPoller;
  stimulateService?: StimulateService;
  firmwareStorageService?: FirmwareStorageService;
  otaPublicBaseUrl?: string;
  otaRedisState?: OtaRedisState;
  otaCommandPublisher?: OtaCommandPublisher;
  otaService?: OtaService;
  otaEventHandler?: OtaEventHandler;
  otaRolloutScheduler?: RolloutSchedulerHandle;
  mqttIngressState: MqttIngressRouterState;
  loyaltyService?: LoyaltyService;
  ensureLoyaltyService(): Promise<LoyaltyService>;
  isServicesReady: boolean;
  isIngressReady: boolean;
  keepAliveTimer: ReturnType<typeof setInterval> | null;

  getRedisClientOrNull(): ReturnType<RedisService['getClient']> | null;
  redisMarkDeviceActive(deviceId: string): Promise<void>;
  redisRemoveDevice(deviceId: string): Promise<void>;
  loadLatestInstagramSocialForUser(
    userIdStr: string
  ): Promise<{ socialAccountId: string; accessToken: string; tokenExp?: Date } | null>;
  buildReadinessPayload(): Promise<Record<string, unknown>>;
  initializeOtaServices(): void;
  processDeferredWork(): Promise<void>;
  flushMqttMessageBuffer(): Promise<void>;
  ensureDeviceProvisioned(deviceId: string): Promise<boolean>;
  deliverOtaOnRegistration(deviceId: string, appVersion?: string): Promise<void>;
  initializeProvisioning(): Promise<void>;
}
