/**
 * Certificate Transparency Log — Internal Merkle Tree Implementation
 * 
 * PKI Improvement #7: Append-only, cryptographically verifiable log of all certificate issuances.
 * 
 * Storage: InfluxDB (time-series) — replaces MongoDB for transparency entries.
 * InfluxDB provides native time-based queries, retention policies, and fits the
 * append-only nature of transparency logs perfectly.
 * 
 * Core components:
 * - Merkle Tree: Binary hash tree providing O(log n) inclusion proofs (in-memory)
 * - Inclusion Proof: Mathematical receipt proving a certificate is in the tree
 * - Root Hash: "Master fingerprint" of every certificate ever issued
 * 
 * Phases:
 * 1. Merkle Tree Implementation (this file)
 * 2. Device-Side Verification (firmware)
 * 3. Root Hash Distribution (MQTT publish)
 * 4. Consistency Monitoring (jobs/transparencyMonitor)
 */

import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { getInfluxService } from './influxService';

export interface TransparencyProof {
  index: number;
  leafHash: string;
  rootHash: string;
  inclusionProof: Array<{ hash: string; position: 'left' | 'right' }>;
}

export interface TransparencyLogConfig {
  enabled: boolean;
}

export class TransparencyLog {
  private config: TransparencyLogConfig;
  /** In-memory leaf hashes for computing tree (rebuilt on init from InfluxDB) */
  private leaves: string[] = [];
  private initialized: boolean = false;

  constructor(config?: Partial<TransparencyLogConfig>) {
    this.config = {
      enabled: config?.enabled !== false
    };
  }

  /**
   * Initialize by loading existing leaf hashes from InfluxDB.
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Transparency Log disabled (set TRANSPARENCY_LOG_ENABLED=true to enable)');
      this.initialized = true;
      return;
    }

    try {
      const influx = getInfluxService();
      if (influx) {
        const entries = await influx.queryTransparencyLeaves();
        // Sort by index and extract leaf hashes in order
        entries.sort((a, b) => a.index - b.index);
        this.leaves = entries.map(e => e.leafHash);
        logger.info('Transparency Log initialized from InfluxDB', { entryCount: this.leaves.length });
      } else {
        logger.warn('Transparency Log: InfluxDB not available, starting empty');
      }
      this.initialized = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Transparency Log initialization failed', { error: msg });
      this.initialized = true;
    }
  }

  /**
   * Add a certificate issuance to the transparency log.
   * Returns inclusion proof + root hash for the device.
   */
  async addEntry(
    certFingerprint: string,
    serialNumber: string,
    cn: string,
    deviceId: string,
    timestamp?: Date
  ): Promise<TransparencyProof | null> {
    if (!this.config.enabled) return null;
    if (!this.initialized) await this.initialize();

    try {
      const issuedAt = timestamp || new Date();

      // Compute leaf hash
      const leafData = `${certFingerprint}|${serialNumber}|${cn}|${issuedAt.toISOString()}`;
      const leafHash = this.hash(leafData);

      // Add to in-memory tree
      this.leaves.push(leafHash);
      const index = this.leaves.length - 1;

      // Compute new root hash and inclusion proof
      const rootHash = this.computeRootHash();
      const inclusionProof = this.computeInclusionProof(index);

      // Persist to InfluxDB
      const influx = getInfluxService();
      if (influx) {
        await influx.writeTransparencyEntry({
          index,
          leafHash,
          rootHash,
          inclusionProof: JSON.stringify(inclusionProof),
          certFingerprint,
          serialNumber,
          cn,
          deviceId,
          issuedAt
        });
      } else {
        logger.warn('Transparency Log: InfluxDB not available, entry stored in-memory only', { index, deviceId });
      }

      logger.debug('Transparency log entry added', {
        index,
        leafHash: leafHash.substring(0, 16) + '...',
        rootHash: rootHash.substring(0, 16) + '...',
        deviceId
      });

      return { index, leafHash, rootHash, inclusionProof };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to add transparency log entry', { error: msg, deviceId });
      return null;
    }
  }

  /**
   * Verify that a leaf (certificate) is included in the tree.
   * Uses the inclusion proof to reconstruct the root hash and compare.
   */
  verifyInclusion(leafHash: string, inclusionProof: Array<{ hash: string; position: 'left' | 'right' }>, expectedRoot: string): boolean {
    try {
      let current = leafHash;

      for (const step of inclusionProof) {
        if (step.position === 'left') {
          current = this.hash(step.hash + current);
        } else {
          current = this.hash(current + step.hash);
        }
      }

      return current === expectedRoot;
    } catch {
      return false;
    }
  }

  /**
   * Get the current root hash of the transparency tree.
   */
  getCurrentRootHash(): string {
    if (this.leaves.length === 0) return this.hash('EMPTY_TREE');
    return this.computeRootHash();
  }

  /**
   * Get the total number of entries in the log.
   */
  getEntryCount(): number {
    return this.leaves.length;
  }

  /**
   * Verify the entire tree's consistency.
   * Rebuilds tree from InfluxDB and compares root hashes.
   */
  async verifyConsistency(): Promise<{ valid: boolean; entryCount: number; errors: string[] }> {
    const errors: string[] = [];

    try {
      const influx = getInfluxService();
      if (!influx) {
        return { valid: false, entryCount: 0, errors: ['InfluxDB not available'] };
      }

      const entries = await influx.queryTransparencyLeaves();
      entries.sort((a, b) => a.index - b.index);

      // Rebuild tree from stored leaves
      const rebuildLeaves: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        rebuildLeaves.push(entries[i].leafHash);

        // Check index continuity
        if (entries[i].index !== i) {
          errors.push(`Index gap: expected ${i}, found ${entries[i].index}`);
        }
      }

      // Verify root hash matches recomputed
      if (rebuildLeaves.length > 0) {
        const savedLeaves = this.leaves;
        this.leaves = rebuildLeaves;
        const recomputedRoot = this.computeRootHash();
        this.leaves = savedLeaves; // Restore

        const inMemoryRoot = this.computeRootHash();
        if (recomputedRoot !== inMemoryRoot && savedLeaves.length === rebuildLeaves.length) {
          errors.push(`Root hash mismatch: influxDB=${recomputedRoot.substring(0, 16)}..., memory=${inMemoryRoot.substring(0, 16)}...`);
        }
      }

      const valid = errors.length === 0;
      if (valid) {
        logger.info('Transparency log consistency verified', { entryCount: entries.length });
      } else {
        logger.error('Transparency log consistency FAILED', { entryCount: entries.length, errors });
      }

      return { valid, entryCount: entries.length, errors };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, entryCount: 0, errors: [msg] };
    }
  }

  // --- Private Merkle Tree Helpers ---

  private hash(data: string): string {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
  }

  /**
   * Compute the Merkle root hash from all leaves.
   * Uses a simple binary tree: if odd number of nodes, duplicate the last.
   */
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

  /**
   * Compute inclusion proof for a leaf at the given index.
   * Returns the sibling hashes needed to reconstruct the root.
   */
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

      // Find sibling
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

// --- Singleton ---

let transparencyLogInstance: TransparencyLog | null = null;

export function createTransparencyLog(config?: Partial<TransparencyLogConfig>): TransparencyLog {
  transparencyLogInstance = new TransparencyLog(config);
  return transparencyLogInstance;
}

export function getTransparencyLog(): TransparencyLog | null {
  return transparencyLogInstance;
}
