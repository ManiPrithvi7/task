import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { getInfluxService } from './influxService';
import { getAuditService, AuditEventType } from './auditService';

export interface OtaReleaseLogEntry {
  index: number;
  leafHash: string;
  rootHash: string;
  inclusionProof: string;
  version: string;
  sha256: string;
  objectKey: string;
  keyFingerprint?: string;
  releasedAt: Date;
}

export class OtaReleaseLog {
  private leaves: string[] = [];
  private initialized = false;

  async initialize(): Promise<void> {
    try {
      const influx = getInfluxService();
      if (influx) {
        const entries = await influx.queryOtaReleaseLeaves();
        entries.sort((a, b) => a.index - b.index);
        this.leaves = entries.map(e => e.leafHash);
        logger.info('OTA Release Log initialized from InfluxDB', { entryCount: this.leaves.length });
      } else {
        logger.warn('OTA Release Log: InfluxDB not available, starting empty');
      }
      this.initialized = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('OTA Release Log initialization failed', { error: msg });
      this.initialized = true;
    }
  }

  async addEntry(version: string, sha256: string, objectKey: string, keyFingerprint?: string, releasedAt?: Date): Promise<OtaReleaseLogEntry | null> {
    if (!this.initialized) await this.initialize();

    try {
      const timestamp = releasedAt || new Date();
      const leafData = `${version}|${sha256}|${objectKey}|${keyFingerprint || ''}|${timestamp.toISOString()}`;
      const leafHash = this.hash(leafData);

      this.leaves.push(leafHash);
      const index = this.leaves.length - 1;
      const rootHash = this.computeRootHash();
      const inclusionProof = this.computeInclusionProof(index);
      const proofJson = JSON.stringify(inclusionProof);

      const influx = getInfluxService();
      if (influx) {
        await influx.writeOtaReleaseEntry({
          index,
          leafHash,
          rootHash,
          inclusionProof: proofJson,
          version,
          sha256,
          objectKey,
          keyFingerprint: keyFingerprint || '',
          releasedAt: timestamp
        });
      } else {
        logger.warn('OTA Release Log: InfluxDB not available, entry stored in-memory only', { index, version });
      }

      void getAuditService()
        ?.logEvent({
          event: AuditEventType.OTA_RELEASE_LOG_ENTRY,
          details: { index, version, sha256, keyFingerprint, leafHash: leafHash.substring(0, 16) }
        })
        .catch(() => undefined);

      logger.debug('OTA release log entry added', {
        index,
        version,
        leafHash: leafHash.substring(0, 16),
        rootHash: rootHash.substring(0, 16),
      });

      return { index, leafHash, rootHash, inclusionProof: proofJson, version, sha256, objectKey, keyFingerprint, releasedAt: timestamp };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to add OTA release log entry', { error: msg, version });
      return null;
    }
  }

  getEntryCount(): number {
    return this.leaves.length;
  }

  getCurrentRootHash(): string {
    if (this.leaves.length === 0) return this.hash('EMPTY_TREE');
    return this.computeRootHash();
  }

  private hash(data: string): string {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
  }

  private computeRootHash(): string {
    if (this.leaves.length === 0) return this.hash('EMPTY_TREE');
    if (this.leaves.length === 1) return this.leaves[0];
    let level = [...this.leaves];
    while (level.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 < level.length) {
          nextLevel.push(this.hash(level[i] + level[i + 1]));
        } else {
          nextLevel.push(this.hash(level[i] + level[i]));
        }
      }
      level = nextLevel;
    }
    return level[0];
  }

  private computeInclusionProof(targetIndex: number): Array<{ hash: string; position: 'left' | 'right' }> {
    const proof: Array<{ hash: string; position: 'left' | 'right' }> = [];
    if (this.leaves.length <= 1) return proof;
    let level = [...this.leaves];
    let idx = targetIndex;
    while (level.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 < level.length) {
          nextLevel.push(this.hash(level[i] + level[i + 1]));
        } else {
          nextLevel.push(this.hash(level[i] + level[i]));
        }
      }
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (siblingIdx < level.length) {
        proof.push({
          hash: level[siblingIdx],
          position: idx % 2 === 0 ? 'right' : 'left'
        });
      } else {
        proof.push({
          hash: level[idx],
          position: 'right'
        });
      }
      idx = Math.floor(idx / 2);
      level = nextLevel;
    }
    return proof;
  }
}

let otaReleaseLogInstance: OtaReleaseLog | null = null;

export function createOtaReleaseLog(): OtaReleaseLog {
  otaReleaseLogInstance = new OtaReleaseLog();
  return otaReleaseLogInstance;
}

export function getOtaReleaseLog(): OtaReleaseLog | null {
  return otaReleaseLogInstance;
}
