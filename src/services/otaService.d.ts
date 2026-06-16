/**
 * OTA — update resolution, release validation, CI webhook ingest, device state.
 */
import type { RedisClientType } from 'redis';
import type { MqttClientManager } from '../servers/mqttClient';
import type { OtaConfig } from '../config';
import { DeviceOtaState } from '../models/Device';
import { type IFirmwareRelease } from '../models/FirmwareRelease';
import type { IFirmwareStorage, ObjectHeadResult } from './firmwareStorageService';
export declare const OTA_MAX_FIRMWARE_BYTES: number;
export interface FinalizeValidationInput {
    version: string;
    sha256: string;
    signature: string;
    head: ObjectHeadResult;
    signingPublicKeyPem?: string;
    /** @deprecated use signingPublicKeyPem */
    signingPublicKeyPath?: string;
}
export type FinalizeValidationCode = 'INVALID_SHA256' | 'INVALID_SIGNATURE' | 'SIGNING_KEY_MISSING' | 'INVALID_VERSION' | 'SIZE_INVALID' | 'SIZE_MISMATCH' | 'METADATA_VERSION_MISMATCH' | 'METADATA_SHA256_MISMATCH' | 'METADATA_MISSING';
export declare class FinalizeValidationError extends Error {
    readonly code: FinalizeValidationCode;
    readonly httpStatus: number;
    constructor(message: string, code: FinalizeValidationCode, httpStatus?: number);
}
export declare function assertValidVersionFormat(version: string): void;
export declare function assertValidSha256Hex(sha256: string): void;
export declare function verifyEd25519Signature(sha256Hex: string, signatureB64: string, publicKeyPem: string): boolean;
export declare function validateFinalizeInput(input: FinalizeValidationInput): void;
export interface OtaActiveRelease {
    version: string;
    sha256: string;
    signature: string;
    objectKey: string;
    sizeBytes: number;
    releasedAt: string;
}
export declare class OtaRedisState {
    private readonly getClient;
    private readonly keyPrefix;
    constructor(getClient: () => RedisClientType | null, keyPrefix: string);
    private activeReleaseKey;
    private pendingKey;
    private deliveredKey;
    setActiveRelease(release: OtaActiveRelease): Promise<void>;
    getActiveRelease(): Promise<OtaActiveRelease | null>;
    seedPendingFleet(version: string, deviceIds: string[]): Promise<void>;
    isPending(deviceId: string, version: string): Promise<boolean>;
    isDelivered(deviceId: string, version: string): Promise<boolean>;
    markDelivered(deviceId: string, version: string): Promise<void>;
    markPending(deviceId: string, version: string): Promise<void>;
}
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
export declare class OtaCommandPublisher {
    private readonly mqttClient;
    private readonly topicRoot;
    private readonly broadcastTopic;
    private readonly otaRedisState?;
    constructor(mqttClient: MqttClientManager, topicRoot: string, broadcastTopic: string, otaRedisState?: OtaRedisState | undefined);
    publishUpdateToDevice(deviceId: string, offer: OtaUpdateOffer, force?: boolean): Promise<void>;
    publishBroadcastUpdate(offer: OtaUpdateOffer, force?: boolean): Promise<void>;
    publishRollbackAck(deviceId: string, version: string): Promise<void>;
}
export type OtaEventPayload = {
    type?: string;
    event?: string;
    version?: string;
    attempted_version?: string;
    reason?: string;
    reasons?: string[];
    boot_attempts?: number;
    progress?: number;
    status?: string;
};
export declare class OtaEventHandler {
    private readonly otaService;
    private readonly commandPublisher;
    constructor(otaService: OtaService, commandPublisher: OtaCommandPublisher);
    handle(deviceId: string, payload: OtaEventPayload): Promise<void>;
}
export declare function checkOtaRateLimit(client: RedisClientType | null, keyPrefix: string, deviceId: string, windowSec: number): Promise<boolean>;
export declare function initOtaSigningState(envConfirmed: boolean): void;
export declare function isOtaSigningConfirmed(envConfirmed: boolean): boolean;
export declare function setOtaSigningConfirmed(confirmed: boolean): void;
export declare function getRuntimeSigningConfirmed(): boolean;
export interface OtaUpdateOffer {
    version: string;
    downloadUrl: string;
    sha256: string;
    signature: string;
    sizeBytes: number;
    expiresAt: string;
}
export interface ResolveUpdateInput {
    deviceId: string;
    currentVersion: string;
    hardwareRev?: string;
    platform?: string;
}
export interface OtaReleaseWebhookInput {
    version: string;
    objectKey: string;
    sha256: string;
    signature: string;
    sizeBytes?: number;
    releasedAt?: string;
    broadcast?: boolean;
}
export type OtaReleaseWebhookResult = {
    ok: true;
    version: string;
    broadcast: boolean;
    created: boolean;
} | {
    ok: false;
    httpStatus: number;
    code: string;
    error: string;
};
export declare class OtaService {
    private readonly otaConfig;
    private readonly storage;
    private readonly publicBaseUrl;
    private readonly commandPublisher?;
    private readonly otaRedisState?;
    constructor(otaConfig: OtaConfig, storage: IFirmwareStorage, publicBaseUrl: string, commandPublisher?: OtaCommandPublisher | undefined, otaRedisState?: OtaRedisState | undefined);
    resolveUpdate(input: ResolveUpdateInput): Promise<OtaUpdateOffer | null>;
    ingestRelease(input: OtaReleaseWebhookInput): Promise<OtaReleaseWebhookResult>;
    deliverPendingToDevice(deviceId: string, currentVersion: string): Promise<void>;
    private listEligibleDeviceIds;
    private pushReleaseToOnlineDevices;
    markDeviceDelivered(deviceId: string, version: string): Promise<void>;
    private isDeviceEligible;
    private matchesHardware;
    private matchesRollout;
    private deviceHashBucket;
    private buildOffer;
    getStableRelease(version: string): Promise<IFirmwareRelease | null>;
    recordRollbackFailure(deviceId: string, version: string, reason?: string): Promise<{
        blocked: boolean;
        failures: number;
    }>;
    recordOtaSuccess(deviceId: string, version: string): Promise<void>;
    updateOtaState(deviceId: string, state: DeviceOtaState): Promise<void>;
    updateFirmwareVersion(deviceId: string, version: string): Promise<void>;
}
export declare function isValidObjectId(value: string): boolean;
//# sourceMappingURL=otaService.d.ts.map