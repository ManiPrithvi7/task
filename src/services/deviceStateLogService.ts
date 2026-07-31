import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { getInfluxService } from './influxService';

export type DeviceStateEvent = 'active' | 'inactive';

export interface DeviceStateTransitionInput {
  deviceId: string;
  event: DeviceStateEvent;
  fwVersion?: string;
  fwTrack?: string;
  ipHash?: string;
  userIdAtTime?: string;
  reason: string;
  timestamp?: Date;
}

interface ChainState {
  lastSequence: number;
  lastHash: string;
}

/**
 * Per-device hash chain for device_state_log (compliance) + companion device_active (metrics).
 * In-memory chain state (same pattern as auditService). TODO: Redis for multi-instance.
 */
export class DeviceStateLogService {
  private chains = new Map<string, ChainState>();
  private initialized = false;

  async initialize(): Promise<void> {
    try {
      const influx = getInfluxService();
      if (influx) {
        const latestByDevice = await influx.queryLatestDeviceStateEntries();
        for (const [deviceId, row] of latestByDevice) {
          this.chains.set(deviceId, {
            lastSequence: row.sequence,
            lastHash: row.hash
          });
        }
        logger.info('DeviceStateLogService initialized from InfluxDB', {
          deviceCount: this.chains.size
        });
      } else {
        logger.warn('DeviceStateLogService: InfluxDB not available — genesis per device on first write');
      }
      this.initialized = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('DeviceStateLogService initialization failed', { error: msg });
      this.initialized = true;
    }
  }

  async recordTransition(input: DeviceStateTransitionInput): Promise<void> {
    if (!this.initialized) await this.initialize();

    const influx = getInfluxService();
    if (!influx) return;

    const timestamp = input.timestamp ?? new Date();
    let state = this.chains.get(input.deviceId);
    if (!state) {
      const latest = await influx.queryLatestDeviceStateEntry(input.deviceId);
      state = latest
        ? { lastSequence: latest.sequence, lastHash: latest.hash }
        : { lastSequence: 0, lastHash: 'GENESIS' };
      this.chains.set(input.deviceId, state);
    }

    const previousHash = state.lastHash;
    const sequence = state.lastSequence + 1;

    const hashContent = {
      deviceId: input.deviceId,
      event: input.event,
      fwTrack: input.fwTrack || null,
      fwVersion: input.fwVersion || null,
      ipHash: input.ipHash || null,
      previousHash,
      timestamp: timestamp.toISOString(),
      userIdAtTime: input.userIdAtTime || null
    };
    const sortedKeys = Object.keys(hashContent).sort();
    const hashPreimage = JSON.stringify(hashContent, sortedKeys);
    const hash = crypto.createHash('sha256').update(hashPreimage, 'utf8').digest('hex');

    await influx.writeDeviceStateLog({
      deviceId: input.deviceId,
      event: input.event,
      sequence,
      hash,
      previousHash,
      hashPreimage,
      fwVersion: input.fwVersion,
      fwTrack: input.fwTrack,
      ipHash: input.ipHash,
      userIdAtTime: input.userIdAtTime,
      timestamp
    });

    await influx.writeDeviceActive({
      deviceId: input.deviceId,
      status: input.event,
      fwVersion: input.fwVersion,
      fwTrack: input.fwTrack,
      ipHash: input.ipHash,
      reason: input.reason,
      userIdAtTime: input.userIdAtTime,
      timestamp
    });

    state.lastSequence = sequence;
    state.lastHash = hash;
  }
}

let instance: DeviceStateLogService | null = null;

export function getDeviceStateLogService(): DeviceStateLogService {
  if (!instance) instance = new DeviceStateLogService();
  return instance;
}

export function createDeviceStateLogService(): DeviceStateLogService {
  instance = new DeviceStateLogService();
  return instance;
}
