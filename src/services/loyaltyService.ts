/**
 * Loyalty join / spin / MQTT ack / WS map.
 * In-memory activeConnections assumes a single Node instance (Redis pub/sub is future work).
 */

import crypto from 'crypto';
import { Device, DeviceStatus } from '../models/Device';
import {
  LoyaltySession,
  LoyaltySessionStatus,
  type ILoyaltySession
} from '../models/LoyaltySession';
import {
  LOYALTY_IN_FLIGHT_SPIN_STATUSES,
  LoyaltySpin,
  LoyaltySpinStatus,
  type ILoyaltySpin,
  type ILoyaltySpinResult
} from '../models/LoyaltySpin';
import type { LoyaltyConfig } from '../config/loyaltyConfig';
import { getActiveDeviceCache } from './deviceService';
import {
  incLoyaltyClockDriftWarn,
  incLoyaltySessionExpiry,
  incLoyaltySpinFailure,
  observeLoyaltyAckLatencyMs,
  observeLoyaltyDeviceAckSkewMs
} from './loyaltyMetrics';
import { isDuplicateKeyError, LoyaltyHttpError } from '../utils/loyaltyErrors';
import { logger } from '../utils/logger';

const CLOCK_DRIFT_WARN_MS = 5000;
const REVEAL_SWEEP_GRACE_MS = 2000;
const DEVICE_ID_MAX = 64;
const SYMBOLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export type LoyaltyMqttClient = {
  publish: (message: {
    topic: string;
    payload: string;
    qos?: 0 | 1 | 2;
    retain?: boolean;
  }) => Promise<void>;
  isConnected: () => boolean;
};

export type LoyaltySocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  readyState: number;
};

export type LoyaltyServiceDeps = {
  mqtt: LoyaltyMqttClient;
  config: LoyaltyConfig;
  topicRoot: string;
  getActiveDevice?: (deviceId: string) => Promise<{ deviceId: string } | null>;
  now?: () => Date;
};

export type LoyaltySpinRequest = {
  sessionId: string;
  idempotencyKey: string;
  spinId: string;
  result: ILoyaltySpinResult;
};

export type LoyaltyConnection = {
  sessionId: string;
  socket: LoyaltySocket;
  expiresAt: Date;
};

const JOINABLE_DEVICE_STATUSES = new Set<string>([DeviceStatus.PROVISIONED, DeviceStatus.ACTIVE]);

function apiSpinStatus(status: LoyaltySpinStatus): string {
  return status.toLowerCase();
}

function resultsEqual(a: ILoyaltySpinResult, b: ILoyaltySpinResult): boolean {
  return (
    a.value === b.value &&
    a.reward === b.reward &&
    a.digits.length === b.digits.length &&
    a.digits.every((d, i) => d === b.digits[i])
  );
}

export function validateLoyaltyResult(result: unknown): ILoyaltySpinResult {
  if (!result || typeof result !== 'object') {
    throw new LoyaltyHttpError(400, 'INVALID_RESULT', 'result is required');
  }
  const r = result as { digits?: unknown; value?: unknown; reward?: unknown };
  if (!Array.isArray(r.digits) || r.digits.length !== 3) {
    throw new LoyaltyHttpError(400, 'INVALID_RESULT', 'result.digits must be 3 numbers 0–9');
  }
  const digits: number[] = [];
  for (const d of r.digits) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 9) {
      throw new LoyaltyHttpError(400, 'INVALID_RESULT', 'result.digits must be 3 numbers 0–9');
    }
    digits.push(d);
  }
  if (typeof r.value !== 'string' || r.value.length === 0) {
    throw new LoyaltyHttpError(400, 'INVALID_RESULT', 'result.value is required');
  }
  if (typeof r.reward !== 'string' || r.reward.length === 0) {
    throw new LoyaltyHttpError(400, 'INVALID_RESULT', 'result.reward is required');
  }
  return { digits, value: r.value, reward: r.reward };
}

export function parseLoyaltyAckDeviceId(topic: string, topicRoot: string): string | null {
  const root = topicRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = topic.match(new RegExp(`^${root}/([^/]+)/ack$`));
  return m ? m[1] : null;
}

function toIso(d: Date): string {
  return d.toISOString();
}

function spinPublic(spin: ILoyaltySpin, includeResult: boolean) {
  const body: Record<string, unknown> = {
    spinId: spin.spinId,
    status: apiSpinStatus(spin.status)
  };
  if (spin.startedAt) body.startedAt = toIso(spin.startedAt);
  if (spin.ttlMs != null) body.ttlMs = spin.ttlMs;
  if (spin.revealAt) body.revealAt = toIso(spin.revealAt);
  if (includeResult) body.result = spin.result;
  return body;
}

export class LoyaltyService {
  /** deviceId → live browser socket. Single Node instance only. */
  readonly activeConnections = new Map<string, LoyaltyConnection>();

  private ackTimer?: ReturnType<typeof setInterval>;
  private sessionTimer?: ReturnType<typeof setInterval>;
  private readonly mqtt: LoyaltyMqttClient;
  private readonly config: LoyaltyConfig;
  private readonly topicRoot: string;
  private readonly getActiveDevice: (deviceId: string) => Promise<{ deviceId: string } | null>;
  private readonly now: () => Date;

  constructor(deps: LoyaltyServiceDeps) {
    this.mqtt = deps.mqtt;
    this.config = deps.config;
    this.topicRoot = deps.topicRoot;
    this.getActiveDevice =
      deps.getActiveDevice ?? ((id) => getActiveDeviceCache().getActive(id));
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (this.ackTimer) return;
    // Interval only — no per-spin setTimeout (ack timeout + reveal are swept from Mongo).
    void this.sweepAckTimeouts();
    void this.sweepSessions();
    this.ackTimer = setInterval(() => {
      void this.sweepAckTimeouts();
    }, 1000);
    this.sessionTimer = setInterval(() => {
      void this.sweepSessions();
    }, 5000);
    this.ackTimer.unref?.();
    this.sessionTimer.unref?.();
  }

  stop(): void {
    if (this.ackTimer) clearInterval(this.ackTimer);
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    this.ackTimer = undefined;
    this.sessionTimer = undefined;
    for (const [deviceId, conn] of this.activeConnections) {
      try {
        conn.socket.close(1001, 'server shutdown');
      } catch {
        /* ignore */
      }
      this.activeConnections.delete(deviceId);
    }
  }

  sendJson(deviceId: string, payload: Record<string, unknown>): void {
    const conn = this.activeConnections.get(deviceId);
    if (!conn || conn.socket.readyState !== 1) {
      logger.info('loyalty WS skip (no live browser socket)', {
        deviceId,
        event: payload.event,
        sessionId: conn?.sessionId
      });
      return;
    }
    try {
      conn.socket.send(JSON.stringify(payload));
      logger.info('loyalty WS sent', { deviceId, event: payload.event, sessionId: conn.sessionId });
    } catch (err: unknown) {
      logger.warn('loyalty WS send failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async join(deviceIdRaw: unknown): Promise<{ sessionId: string; deviceId: string; expiresAt: string }> {
    if (typeof deviceIdRaw !== 'string' || !deviceIdRaw.trim()) {
      throw new LoyaltyHttpError(400, 'INVALID_DEVICE_ID', 'deviceId is required');
    }
    const deviceId = deviceIdRaw.trim();
    if (deviceId.length > DEVICE_ID_MAX) {
      throw new LoyaltyHttpError(400, 'INVALID_DEVICE_ID', 'deviceId is invalid');
    }

    const device = await Device.findOne({ clientId: deviceId }).lean();
    if (!device || !JOINABLE_DEVICE_STATUSES.has(device.status)) {
      throw new LoyaltyHttpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
    }

    const active = await this.getActiveDevice(deviceId);
    if (!active) {
      throw new LoyaltyHttpError(503, 'DEVICE_OFFLINE', 'Display offline');
    }

    const supersedeBefore = new Date(this.now().getTime() - this.config.createdSupersedeMs);
    await LoyaltySession.findOneAndUpdate(
      {
        deviceId,
        status: LoyaltySessionStatus.CREATED,
        wsConnectedAt: { $exists: false },
        createdAt: { $lt: supersedeBefore }
      },
      { $set: { status: LoyaltySessionStatus.EXPIRED } }
    );

    const sessionId = `ls_${crypto.randomBytes(18).toString('base64url')}`;
    const expiresAt = new Date(this.now().getTime() + this.config.sessionTtlMs);

    try {
      await LoyaltySession.create({
        sessionId,
        deviceId,
        status: LoyaltySessionStatus.CREATED,
        expiresAt
      });
    } catch (err: unknown) {
      if (isDuplicateKeyError(err, 'deviceId') || isDuplicateKeyError(err)) {
        throw new LoyaltyHttpError(409, 'ACTIVE_SESSION_EXISTS', 'An active session already exists for this device');
      }
      throw err;
    }

    return { sessionId, deviceId, expiresAt: toIso(expiresAt) };
  }

  async attachWs(sessionId: string, socket: LoyaltySocket): Promise<{ sessionId: string; deviceId: string }> {
    const session = await LoyaltySession.findOne({ sessionId });
    if (
      !session ||
      session.expiresAt.getTime() <= this.now().getTime() ||
      (session.status !== LoyaltySessionStatus.CREATED &&
        session.status !== LoyaltySessionStatus.READY &&
        session.status !== LoyaltySessionStatus.SPINNING)
    ) {
      throw new LoyaltyHttpError(401, 'SESSION_INVALID', 'Session is invalid or expired');
    }

    const existing = this.activeConnections.get(session.deviceId);
    if (existing && existing.sessionId !== sessionId) {
      logger.warn('loyalty WS map collision', {
        deviceId: session.deviceId,
        mappedSessionId: existing.sessionId,
        incomingSessionId: sessionId
      });
      throw new LoyaltyHttpError(401, 'SESSION_MISMATCH', 'Another session owns this device socket');
    }

    if (session.status === LoyaltySessionStatus.SPINNING) {
      const inflight = await LoyaltySpin.findOne({
        sessionId,
        status: { $in: [...LOYALTY_IN_FLIGHT_SPIN_STATUSES] }
      });
      if (!inflight) {
        session.status = LoyaltySessionStatus.READY;
      }
    }

    if (session.status === LoyaltySessionStatus.CREATED) {
      session.status = LoyaltySessionStatus.READY;
    }
    session.wsConnectedAt = this.now();
    await session.save();

    this.activeConnections.set(session.deviceId, {
      sessionId,
      socket,
      expiresAt: session.expiresAt
    });

    return { sessionId, deviceId: session.deviceId };
  }

  detachWs(deviceId: string, sessionId: string): void {
    const mapped = this.activeConnections.get(deviceId);
    if (mapped && mapped.sessionId === sessionId) {
      this.activeConnections.delete(deviceId);
    }
  }

  async spin(body: LoyaltySpinRequest): Promise<Record<string, unknown>> {
    const result = validateLoyaltyResult(body.result);
    const { sessionId, idempotencyKey, spinId } = body;
    if (!sessionId || !idempotencyKey || !spinId) {
      throw new LoyaltyHttpError(400, 'INVALID_REQUEST', 'sessionId, idempotencyKey, and spinId are required');
    }

    let spin = await LoyaltySpin.findOne({ sessionId, idempotencyKey });
    if (spin && !this.spinNeedsMqtt(spin)) {
      logger.info('loyalty spin idempotent skip (already published)', {
        spinId: spin.spinId,
        status: spin.status,
        deviceId: spin.deviceId
      });
      return spinPublic(spin, true);
    }

    const session = await LoyaltySession.findOne({ sessionId });
    if (!session) {
      throw new LoyaltyHttpError(410, 'SESSION_EXPIRED', 'Session expired');
    }
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      throw new LoyaltyHttpError(410, 'SESSION_EXPIRED', 'Session expired');
    }
    const sessionOpen =
      session.status === LoyaltySessionStatus.CREATED ||
      session.status === LoyaltySessionStatus.READY ||
      session.status === LoyaltySessionStatus.SPINNING;
    if (!sessionOpen) {
      throw new LoyaltyHttpError(410, 'SESSION_EXPIRED', 'Session expired');
    }

    if (!spin) {
      if (session.status === LoyaltySessionStatus.SPINNING) {
        throw new LoyaltyHttpError(409, 'SPIN_IN_PROGRESS', 'A spin is already in progress');
      }
      const inflight = await LoyaltySpin.findOne({
        deviceId: session.deviceId,
        status: { $in: [...LOYALTY_IN_FLIGHT_SPIN_STATUSES] }
      });
      if (inflight) {
        throw new LoyaltyHttpError(409, 'SPIN_IN_PROGRESS', 'A spin is already in progress for this device');
      }

      const issuedAt = this.now();
      const commandExpiresAt = new Date(issuedAt.getTime() + this.config.commandTtlMs);
      try {
        spin = await LoyaltySpin.create({
          spinId,
          sessionId,
          deviceId: session.deviceId,
          result,
          status: LoyaltySpinStatus.CREATED,
          idempotencyKey,
          ttlMs: this.config.ttlMs,
          issuedAt,
          expiresAt: commandExpiresAt
        });
      } catch (err: unknown) {
        if (isDuplicateKeyError(err, 'idempotencyKey') || isDuplicateKeyError(err, 'sessionId')) {
          const dup = await LoyaltySpin.findOne({ sessionId, idempotencyKey });
          if (dup && !this.spinNeedsMqtt(dup)) return spinPublic(dup, true);
          if (dup) spin = dup;
        }
        if (!spin && isDuplicateKeyError(err, 'spinId')) {
          const dup = await LoyaltySpin.findOne({ spinId });
          if (
            dup &&
            dup.sessionId === sessionId &&
            dup.idempotencyKey === idempotencyKey &&
            resultsEqual(dup.result, result)
          ) {
            if (!this.spinNeedsMqtt(dup)) return spinPublic(dup, true);
            spin = dup;
          } else {
            throw new LoyaltyHttpError(409, 'SPIN_ID_CONFLICT', 'spinId already used with different payload');
          }
        }
        if (!spin && isDuplicateKeyError(err, 'deviceId')) {
          throw new LoyaltyHttpError(409, 'SPIN_IN_PROGRESS', 'A spin is already in progress for this device');
        }
        if (!spin) throw err;
      }
    }

    if (!spin) {
      throw new LoyaltyHttpError(500, 'SPIN_CREATE_FAILED', 'Spin could not be created');
    }

    this.fillSpinCommandFields(spin, result);
    const issuedAt = spin.issuedAt ?? this.now();
    const commandExpiresAt =
      spin.expiresAt ?? new Date(issuedAt.getTime() + this.config.commandTtlMs);

    const transitioned = await LoyaltySession.findOneAndUpdate(
      {
        sessionId,
        status: {
          $in: [
            LoyaltySessionStatus.CREATED,
            LoyaltySessionStatus.READY,
            LoyaltySessionStatus.SPINNING
          ]
        }
      },
      { $set: { status: LoyaltySessionStatus.SPINNING } },
      { new: true }
    );
    if (!transitioned) {
      spin.status = LoyaltySpinStatus.FAILED;
      spin.failCode = 'SPIN_IN_PROGRESS';
      spin.failMessage = 'Session is no longer active';
      await spin.save();
      incLoyaltySpinFailure('session_not_ready');
      throw new LoyaltyHttpError(409, 'SPIN_IN_PROGRESS', 'A spin is already in progress');
    }

    await this.publishSpinStart(spin, session.deviceId, issuedAt, commandExpiresAt);

    const publishedAt = this.now();
    const persisted = await LoyaltySpin.findOneAndUpdate(
      {
        spinId: spin.spinId,
        status: {
          $nin: [
            LoyaltySpinStatus.ACK_RECEIVED,
            LoyaltySpinStatus.REVEALED,
            LoyaltySpinStatus.COMPLETED,
            LoyaltySpinStatus.FAILED
          ]
        }
      },
      {
        $set: {
          status: LoyaltySpinStatus.COMMAND_PUBLISHED,
          commandPublishedAt: publishedAt,
          result: spin.result,
          ttlMs: spin.ttlMs,
          issuedAt: spin.issuedAt,
          expiresAt: spin.expiresAt
        }
      },
      { new: true }
    );
    if (persisted) {
      spin.status = persisted.status;
      spin.commandPublishedAt = persisted.commandPublishedAt;
    }

    return spinPublic(spin, true);
  }

  /** Prisma/shared-collection rows often lack Node required paths (`result`, `ttlMs`). */
  private fillSpinCommandFields(spin: ILoyaltySpin, result: ILoyaltySpinResult): void {
    const hasDigits = Array.isArray(spin.result?.digits) && spin.result.digits.length === 3;
    if (!hasDigits) spin.result = result;
    if (spin.ttlMs == null) spin.ttlMs = this.config.ttlMs;
    if (!spin.issuedAt) spin.issuedAt = this.now();
    if (!spin.expiresAt) {
      spin.expiresAt = new Date(spin.issuedAt.getTime() + this.config.commandTtlMs);
    }
  }

  private spinNeedsMqtt(spin: ILoyaltySpin): boolean {
    if (spin.commandPublishedAt) return false;
    const status = String(spin.status || '').toUpperCase();
    if (status === 'FAILED' || status === 'COMPLETED' || status === 'ACK_RECEIVED' || status === 'REVEALED') {
      return false;
    }
    return true;
  }

  private async publishSpinStart(
    spin: ILoyaltySpin,
    deviceId: string,
    issuedAt: Date,
    commandExpiresAt: Date
  ): Promise<void> {
    const topic = `${this.topicRoot}/${deviceId}/loyalty`;
    const mqttPayload = {
      type: 'spin-start',
      spinId: spin.spinId,
      result: spin.result,
      ttlMs: this.config.ttlMs,
      reels: 3,
      symbols: SYMBOLS,
      issuedAt: toIso(issuedAt),
      expiresAt: toIso(commandExpiresAt)
    };

    try {
      if (!this.mqtt.isConnected()) {
        throw new Error('MQTT client not connected');
      }
      await this.mqtt.publish({
        topic,
        payload: JSON.stringify(mqttPayload),
        qos: 2,
        retain: false
      });
    } catch (err: unknown) {
      logger.error('loyalty MQTT publish failed', {
        spinId: spin.spinId,
        deviceId,
        topic,
        error: err instanceof Error ? err.message : String(err)
      });
      await this.failSpin(spin, 'MQTT_PUBLISH_FAILED', 'Failed to publish spin command', true);
      throw new LoyaltyHttpError(503, 'MQTT_PUBLISH_FAILED', 'Failed to publish spin command');
    }

    logger.info('loyalty MQTT spin/start published', {
      spinId: spin.spinId,
      deviceId,
      topic
    });
  }

  async getSpin(spinId: string): Promise<Record<string, unknown>> {
    const spin = await LoyaltySpin.findOne({ spinId });
    if (!spin) {
      throw new LoyaltyHttpError(404, 'SPIN_NOT_FOUND', 'Unknown spinId');
    }
    const includeResult = Boolean(spin.ackReceivedAt);
    return spinPublic(spin, includeResult);
  }

  async handleAck(topic: string, message: unknown): Promise<void> {
    const deviceId = parseLoyaltyAckDeviceId(topic, this.topicRoot);
    if (!deviceId) return;
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; spinId?: string; startedAt?: string; ttlMs?: number };
    if (msg.type !== 'spin-ack') {
      return;
    }
    if (typeof msg.spinId !== 'string') {
      logger.warn('loyalty ack missing spinId', { deviceId });
      return;
    }

    const spin = await LoyaltySpin.findOne({ spinId: msg.spinId, deviceId });
    if (!spin) {
      logger.info('loyalty ack for unknown spin', { deviceId, spinId: msg.spinId });
      return;
    }
    const status = String(spin.status || '').toUpperCase();
    if (status !== 'COMMAND_PUBLISHED' && status !== 'CREATED') {
      logger.info('loyalty ack ignored (status)', { deviceId, spinId: msg.spinId, status: spin.status });
      return;
    }

    const session = await LoyaltySession.findOne({ sessionId: spin.sessionId });
    if (!session || session.status === LoyaltySessionStatus.EXPIRED) {
      logger.info('loyalty ack for inactive session', { deviceId, spinId: msg.spinId });
      return;
    }

    const ackReceivedAt = this.now();
    let startedAt = ackReceivedAt;
    if (typeof msg.startedAt === 'string') {
      const parsed = new Date(msg.startedAt);
      if (!Number.isNaN(parsed.getTime())) {
        startedAt = parsed;
        const drift = Math.abs(parsed.getTime() - ackReceivedAt.getTime());
        if (drift > CLOCK_DRIFT_WARN_MS) {
          incLoyaltyClockDriftWarn();
          logger.warn('loyalty clock drift over warn threshold', {
            spinId: spin.spinId,
            driftMs: drift
          });
        }
        observeLoyaltyDeviceAckSkewMs(drift);
      }
    }

    const ttlMs =
      typeof msg.ttlMs === 'number' && msg.ttlMs > 0
        ? msg.ttlMs
        : spin.ttlMs ?? this.config.ttlMs;
    const revealAt = new Date(ackReceivedAt.getTime() + ttlMs);

    if (spin.commandPublishedAt) {
      observeLoyaltyAckLatencyMs(ackReceivedAt.getTime() - spin.commandPublishedAt.getTime());
    }

    const updated = await LoyaltySpin.findOneAndUpdate(
      { spinId: msg.spinId, deviceId },
      {
        $set: {
          status: LoyaltySpinStatus.ACK_RECEIVED,
          ackReceivedAt,
          startedAt,
          ttlMs,
          revealAt
        }
      },
      { new: true, runValidators: false }
    );
    if (!updated) {
      logger.warn('loyalty ack update missed spin row', { deviceId, spinId: msg.spinId });
      return;
    }

    logger.info('loyalty device ack recorded', {
      deviceId,
      spinId: msg.spinId,
      revealAt: toIso(revealAt)
    });

    const serverNow = this.now();
    this.sendJson(deviceId, {
      event: 'loyalty.spin.started',
      spinId: updated.spinId,
      startedAt: toIso(startedAt),
      ttlMs,
      revealAt: toIso(revealAt),
      serverNow: toIso(serverNow)
    });
  }

  async sweepAckTimeouts(): Promise<void> {
    // Crash path: CREATED with no commandPublishedAt (process died between insert and MQTT).
    const cutoff = new Date(this.now().getTime() - this.config.ackTimeoutMs);
    const stale = await LoyaltySpin.find({
      $or: [
        { status: LoyaltySpinStatus.COMMAND_PUBLISHED, commandPublishedAt: { $lt: cutoff } },
        { status: LoyaltySpinStatus.CREATED, createdAt: { $lt: cutoff } }
      ]
    });
    for (const spin of stale) {
      await this.failSpin(spin, 'ACK_TIMEOUT', 'Device did not acknowledge spin', true);
    }

    const revealCutoff = new Date(this.now().getTime() - REVEAL_SWEEP_GRACE_MS);
    const due = await LoyaltySpin.find({
      status: LoyaltySpinStatus.ACK_RECEIVED,
      revealAt: { $lte: revealCutoff }
    });
    for (const spin of due) {
      spin.status = LoyaltySpinStatus.REVEALED;
      await spin.save();
      await this.completeSession(spin.sessionId, spin.deviceId);
      spin.status = LoyaltySpinStatus.COMPLETED;
      await spin.save();
    }
  }

  async sweepSessions(): Promise<void> {
    const idleCutoff = new Date(this.now().getTime() - this.config.sessionTtlMs);
    const idle = await LoyaltySession.find({
      status: { $in: [LoyaltySessionStatus.CREATED, LoyaltySessionStatus.READY] },
      createdAt: { $lt: idleCutoff }
    });
    for (const session of idle) {
      const spinning = await LoyaltySpin.findOne({
        sessionId: session.sessionId,
        status: { $in: [...LOYALTY_IN_FLIGHT_SPIN_STATUSES, LoyaltySpinStatus.REVEALED] }
      });
      if (spinning) continue;
      await this.expireSession(session, session.wsConnectedAt ? 'idle' : 'no_ws');
    }

    const stuckSpinning = await LoyaltySession.find({ status: LoyaltySessionStatus.SPINNING });
    for (const session of stuckSpinning) {
      const inflight = await LoyaltySpin.findOne({
        sessionId: session.sessionId,
        status: { $in: [...LOYALTY_IN_FLIGHT_SPIN_STATUSES] }
      });
      if (inflight) continue;
      const mapped = this.activeConnections.get(session.deviceId);
      const wsOk = mapped && mapped.sessionId === session.sessionId;
      await LoyaltySession.findOneAndUpdate(
        { sessionId: session.sessionId, status: LoyaltySessionStatus.SPINNING },
        { $set: { status: wsOk ? LoyaltySessionStatus.READY : LoyaltySessionStatus.EXPIRED } }
      );
    }
  }

  private async failSpin(
    spin: ILoyaltySpin,
    code: string,
    message: string,
    recoverSession: boolean
  ): Promise<void> {
    if (spin.status === LoyaltySpinStatus.FAILED || spin.status === LoyaltySpinStatus.COMPLETED) {
      return;
    }
    const updated = await LoyaltySpin.findOneAndUpdate(
      {
        spinId: spin.spinId,
        status: { $nin: [LoyaltySpinStatus.FAILED, LoyaltySpinStatus.COMPLETED] }
      },
      { $set: { status: LoyaltySpinStatus.FAILED, failCode: code, failMessage: message } },
      { new: true }
    );
    if (!updated) return;
    spin.status = LoyaltySpinStatus.FAILED;
    spin.failCode = code;
    spin.failMessage = message;
    incLoyaltySpinFailure(code.toLowerCase());

    this.sendJson(spin.deviceId, {
      event: 'loyalty.spin.failed',
      spinId: spin.spinId,
      code,
      message
    });

    if (!recoverSession) return;

    const mapped = this.activeConnections.get(spin.deviceId);
    const wsOk = mapped && mapped.sessionId === spin.sessionId;
    await LoyaltySession.findOneAndUpdate(
      { sessionId: spin.sessionId, status: LoyaltySessionStatus.SPINNING },
      { $set: { status: wsOk ? LoyaltySessionStatus.READY : LoyaltySessionStatus.CREATED } }
    );
    if (!wsOk) {
      this.activeConnections.delete(spin.deviceId);
    }
  }

  private async completeSession(sessionId: string, deviceId: string): Promise<void> {
    await LoyaltySession.findOneAndUpdate(
      { sessionId, status: { $in: [LoyaltySessionStatus.SPINNING, LoyaltySessionStatus.READY] } },
      { $set: { status: LoyaltySessionStatus.COMPLETED } }
    );
    this.activeConnections.delete(deviceId);
  }

  private async expireSession(session: ILoyaltySession, reason: string): Promise<void> {
    session.status = LoyaltySessionStatus.EXPIRED;
    await session.save();
    incLoyaltySessionExpiry(reason);
    const mapped = this.activeConnections.get(session.deviceId);
    if (mapped && mapped.sessionId === session.sessionId) {
      this.sendJson(session.deviceId, {
        event: 'loyalty.session.error',
        code: 'SESSION_EXPIRED',
        message: 'Session expired'
      });
      try {
        mapped.socket.close(4401, 'session expired');
      } catch {
        /* ignore */
      }
      this.activeConnections.delete(session.deviceId);
    }
  }
}
