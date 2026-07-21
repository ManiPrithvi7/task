import { logger } from '../utils/logger';

export type BufferedMqttMessage = {
  topic: string;
  payload: Buffer;
  packet?: { retain?: boolean; qos?: number };
};

export type MqttIngressHandlers = {
  onActive: (topic: string, message: unknown) => Promise<void>;
  onLwt: (topic: string, message: unknown) => Promise<void>;
  onStatus: (topic: string, message: unknown) => Promise<void>;
  onOtaTelemetry: (topic: string, message: unknown) => Promise<void>;
  onScreenEcho: (topic: string, message: unknown) => Promise<void>;
  onOther: (topic: string, message: unknown, payloadLength: number) => Promise<void>;
  updateLastSeen: (deviceId: string) => Promise<void>;
  ensureProvisioned: (deviceId: string) => Promise<boolean>;
  extractDeviceId: (topic: string) => string | null;
};

export type MqttIngressRouterState = {
  isServicesReady: boolean;
  startupTime: number;
  buffer: BufferedMqttMessage[];
};

const MESSAGE_BUFFER_MAX = 100;
const STARTUP_GRACE_MS = 3000;
const OLD_MESSAGE_MS = 120_000;
const REGISTRATION_RETRY_ATTEMPTS = 3;
const REGISTRATION_RETRY_DELAY_MS = 1000;

export function isLifecycleTopic(topic: string): boolean {
  return topic.endsWith('/active') || topic.endsWith('/lwt');
}

function parseJsonPayload(payload: Buffer): { ok: true; message: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, message: JSON.parse(payload.toString()) };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function isMessageTooOld(message: unknown, now: number): boolean {
  if (!message || typeof message !== 'object') return false;
  const ts = (message as { timestamp?: string }).timestamp;
  if (!ts) return false;
  const age = now - new Date(ts).getTime();
  return age > OLD_MESSAGE_MS;
}

function pushToBuffer(state: MqttIngressRouterState, entry: BufferedMqttMessage): void {
  state.buffer.push(entry);
  if (state.buffer.length > MESSAGE_BUFFER_MAX) {
    state.buffer.shift();
    logger.warn('[MQTT_INGRESS] Message buffer overflow — dropped oldest', {
      max: MESSAGE_BUFFER_MAX
    });
  }
}

async function runWithRegistrationRetry(
  fn: () => Promise<void>,
  topic: string
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= REGISTRATION_RETRY_ATTEMPTS; attempt++) {
    try {
      await fn();
      return;
    } catch (err: unknown) {
      lastErr = err;
      if (attempt < REGISTRATION_RETRY_ATTEMPTS) {
        logger.warn('[MQTT_INGRESS] Registration handler retry', {
          topic,
          attempt,
          error: err instanceof Error ? err.message : String(err)
        });
        await new Promise((r) => setTimeout(r, REGISTRATION_RETRY_DELAY_MS));
      }
    }
  }
  logger.error('[MQTT_INGRESS] Registration handler failed after retries', {
    topic,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr)
  });
  throw lastErr;
}

async function handleCritical(
  topic: string,
  payload: Buffer,
  packet: BufferedMqttMessage['packet'],
  handlers: MqttIngressHandlers
): Promise<void> {
  if (topic.endsWith('/active') && packet?.retain) {
    logger.debug('[MQTT_INGRESS] Ignoring retained /active', { topic });
    return;
  }

  const parsed = parseJsonPayload(payload);
  if (!parsed.ok) {
    if (topic.endsWith('/active')) {
      const deviceId = handlers.extractDeviceId(topic);
      logger.warn('[MQTT_INGRESS] Invalid JSON on /active', { topic, deviceId, error: parsed.error });
    }
    return;
  }

  const message = parsed.message;

  if (topic.endsWith('/active')) {
    await runWithRegistrationRetry(() => handlers.onActive(topic, message), topic);
    return;
  }

  if (topic.endsWith('/lwt')) {
    await handlers.onLwt(topic, message);
  }
}

async function handleNonCritical(
  topic: string,
  payload: Buffer,
  packet: BufferedMqttMessage['packet'],
  handlers: MqttIngressHandlers,
  state: MqttIngressRouterState
): Promise<void> {
  if (packet?.retain) {
    logger.debug('[MQTT_INGRESS] Ignoring retained message', { topic });
    return;
  }

  const uptime = Date.now() - state.startupTime;
  if (uptime < STARTUP_GRACE_MS) {
    logger.debug('[MQTT_INGRESS] Ignoring message during startup grace period', {
      topic,
      uptimeMs: uptime,
      gracePeriodMs: STARTUP_GRACE_MS
    });
    return;
  }

  const parsed = parseJsonPayload(payload);
  if (!parsed.ok) {
    logger.error('[MQTT_INGRESS] Failed to parse MQTT JSON', { topic, error: parsed.error });
    return;
  }

  const message = parsed.message;
  const now = Date.now();

  if (isMessageTooOld(message, now)) {
    logger.debug('[MQTT_INGRESS] Ignoring old non-lifecycle message', {
      topic,
      thresholdSec: OLD_MESSAGE_MS / 1000
    });
    return;
  }

  const incomingDeviceId = handlers.extractDeviceId(topic);
  if (incomingDeviceId) {
    try {
      const allowed = await handlers.ensureProvisioned(incomingDeviceId);
      if (!allowed) {
        logger.warn('[MQTT_INGRESS] Dropping message from unprovisioned device', {
          topic,
          deviceId: incomingDeviceId
        });
        return;
      }
    } catch (err: unknown) {
      logger.error('[MQTT_INGRESS] Provisioning check failed', {
        topic,
        deviceId: incomingDeviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
  }

  if (topic.endsWith('/telemetry')) {
    await handlers.onOtaTelemetry(topic, message);
  } else if (topic.endsWith('/status')) {
    await handlers.onStatus(topic, message);
  } else if (
    topic.endsWith('/instagram') ||
    topic.endsWith('/gmb') ||
    topic.endsWith('/pos') ||
    topic.endsWith('/promotion')
  ) {
    await handlers.onScreenEcho(topic, message);
  } else {
    await handlers.onOther(topic, message, payload.length);
  }

  const deviceId = handlers.extractDeviceId(topic);
  const msgType =
    message && typeof message === 'object'
      ? (message as { type?: string }).type
      : undefined;
  if (deviceId && msgType !== 'un_registration') {
    await handlers.updateLastSeen(deviceId).catch(() => undefined);
  }
}

export async function routeMqttMessage(
  topic: string,
  payload: Buffer,
  packet: BufferedMqttMessage['packet'],
  handlers: MqttIngressHandlers,
  state: MqttIngressRouterState
): Promise<void> {
  try {
    if (isLifecycleTopic(topic)) {
      await handleCritical(topic, payload, packet, handlers);
      return;
    }

    if (!state.isServicesReady) {
      pushToBuffer(state, { topic, payload, packet });
      logger.debug('[MQTT_INGRESS] Buffered non-critical message', {
        topic,
        bufferSize: state.buffer.length
      });
      return;
    }

    await handleNonCritical(topic, payload, packet, handlers, state);
  } catch (err: unknown) {
    logger.error('[MQTT_INGRESS] Error processing MQTT message', {
      topic,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function flushMessageBuffer(
  handlers: MqttIngressHandlers,
  state: MqttIngressRouterState
): Promise<number> {
  if (state.buffer.length === 0) return 0;

  const pending = [...state.buffer];
  state.buffer = [];
  let flushed = 0;

  for (const entry of pending) {
    try {
      await handleNonCritical(entry.topic, entry.payload, entry.packet, handlers, state);
      flushed++;
    } catch (err: unknown) {
      logger.warn('[MQTT_INGRESS] Failed to flush buffered message', {
        topic: entry.topic,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (flushed > 0) {
    logger.info('[MQTT_INGRESS] Flushed buffered messages', { count: flushed });
  }

  return flushed;
}
