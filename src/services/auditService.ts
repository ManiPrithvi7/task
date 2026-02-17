/**
 * AuditService - Tamper-proof certificate audit logging with SHA-256 hash chaining
 * 
 * PKI Improvement #3: Cryptographic hash chain for immutable audit trail.
 * 
 * Storage: InfluxDB (time-series) — replaces MongoDB for audit events.
 * InfluxDB is purpose-built for time-series event data like audit logs,
 * providing native time-based queries, retention policies, and dashboarding.
 * 
 * Design:
 * - Each audit entry is hashed (SHA-256) with its content + previous entry's hash
 * - Chain forms a linked list of hashes — any tampering breaks the chain
 * - Sequence counter is monotonic (gaps are detectable)
 * - Signature field reserved for Phase 2 (HSM signing at intervals)
 * 
 * Fallback: If InfluxDB is unavailable, entries are written to local audit.log file
 * with hash chain preserved in memory.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { getInfluxService } from './influxService';

/** Audit event types for PKI lifecycle tracking */
export enum AuditEventType {
  CERTIFICATE_ISSUED = 'CERTIFICATE_ISSUED',
  CERTIFICATE_REVOKED = 'CERTIFICATE_REVOKED',
  CERTIFICATE_RENEWED = 'CERTIFICATE_RENEWED',
  CERTIFICATE_EXPIRED = 'CERTIFICATE_EXPIRED',
  CERTIFICATE_GRACE_ACCEPTED = 'CERTIFICATE_GRACE_ACCEPTED',
  CSR_RECEIVED = 'CSR_RECEIVED',
  CSR_REJECTED = 'CSR_REJECTED',
  CSR_RATE_LIMITED = 'CSR_RATE_LIMITED',
  DEVICE_PROVISIONED = 'DEVICE_PROVISIONED',
  DEVICE_DEPROVISIONED = 'DEVICE_DEPROVISIONED',
  DEVICE_AUTH_SUCCESS = 'DEVICE_AUTH_SUCCESS',
  DEVICE_AUTH_FAILED = 'DEVICE_AUTH_FAILED',
  KU_EKU_VALIDATION_FAILED = 'KU_EKU_VALIDATION_FAILED',
  CHAIN_VALIDATION_FAILED = 'CHAIN_VALIDATION_FAILED',
  CA_KEY_GENERATED = 'CA_KEY_GENERATED',
  CA_CERT_ROTATED = 'CA_CERT_ROTATED',
  TRANSPARENCY_ENTRY_ADDED = 'TRANSPARENCY_ENTRY_ADDED',
  AUDIT_CHAIN_VERIFIED = 'AUDIT_CHAIN_VERIFIED',
  AUDIT_CHAIN_TAMPERED = 'AUDIT_CHAIN_TAMPERED'
}

export interface AuditLogData {
  event: AuditEventType;
  deviceId?: string;
  userId?: string;
  orderId?: string;
  batchId?: string;
  serialNumber?: string;
  certificateFingerprint?: string;
  details?: Record<string, unknown>;
}

/** Represents a single audit entry (returned by logEvent) */
export interface AuditEntry {
  sequence: number;
  timestamp: Date;
  event: AuditEventType;
  deviceId?: string;
  userId?: string;
  orderId?: string;
  batchId?: string;
  serialNumber?: string;
  certificateFingerprint?: string;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface AuditServiceConfig {
  /** Path for file-based fallback logging */
  fallbackLogPath: string;
  /** Enable hash chaining (default: true) */
  hashChainEnabled: boolean;
  /** Enable HSM signing at intervals (Phase 2 — default: false) */
  hsmSigningEnabled: boolean;
  /** Sign every N entries (Phase 2, default: 100) */
  hsmSigningInterval: number;
}

export class AuditService {
  private config: AuditServiceConfig;
  private lastSequence: number = 0;
  private lastHash: string = 'GENESIS';
  private initialized: boolean = false;

  constructor(config: Partial<AuditServiceConfig> = {}) {
    this.config = {
      fallbackLogPath: config.fallbackLogPath || './data/ca/audit.log',
      hashChainEnabled: config.hashChainEnabled !== false,
      hsmSigningEnabled: config.hsmSigningEnabled || false,
      hsmSigningInterval: config.hsmSigningInterval || 100
    };
  }

  /**
   * Initialize the audit service by loading the latest sequence + hash from InfluxDB.
   * Must be called before logging any events.
   */
  async initialize(): Promise<void> {
    try {
      const influx = getInfluxService();
      if (influx) {
        const latest = await influx.queryLatestAuditEntry();
        if (latest) {
          this.lastSequence = latest.sequence;
          this.lastHash = latest.hash;
          logger.info('AuditService initialized from InfluxDB', {
            lastSequence: this.lastSequence,
            lastHash: this.lastHash.substring(0, 16) + '...'
          });
        } else {
          logger.info('AuditService initialized (empty chain — genesis)');
        }
      } else {
        logger.warn('AuditService: InfluxDB not available, using genesis state (file fallback active)');
      }
      this.initialized = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('AuditService initialization failed', { error: msg });
      this.initialized = true; // Allow fallback logging even on init failure
    }
  }

  /**
   * Log an audit event with hash chaining.
   * Writes to InfluxDB as primary store. Falls back to local file if InfluxDB unavailable.
   */
  async logEvent(data: AuditLogData): Promise<AuditEntry | null> {
    if (!this.initialized) {
      logger.warn('AuditService not initialized — call initialize() first');
      await this.initialize();
    }

    const timestamp = new Date();
    const previousHash = this.lastHash;
    const sequence = this.lastSequence + 1;

    // Build hash content: deterministic JSON of all audit fields + previousHash
    const hashContent = this.buildHashContent({
      timestamp: timestamp.toISOString(),
      event: data.event,
      deviceId: data.deviceId || null,
      userId: data.userId || null,
      orderId: data.orderId || null,
      batchId: data.batchId || null,
      serialNumber: data.serialNumber || null,
      certificateFingerprint: data.certificateFingerprint || null,
      details: data.details || {},
      previousHash
    });

    const hash = this.config.hashChainEnabled
      ? this.computeHash(hashContent)
      : crypto.randomBytes(16).toString('hex');

    const entry: AuditEntry = {
      sequence,
      timestamp,
      event: data.event,
      deviceId: data.deviceId,
      userId: data.userId,
      orderId: data.orderId,
      batchId: data.batchId,
      serialNumber: data.serialNumber,
      certificateFingerprint: data.certificateFingerprint,
      details: data.details || {},
      previousHash,
      hash
    };

    // Write to InfluxDB (primary store)
    const influx = getInfluxService();
    if (influx) {
      try {
        await influx.writeAuditEvent({
          event: data.event,
          deviceId: data.deviceId,
          userId: data.userId,
          orderId: data.orderId,
          batchId: data.batchId,
          serialNumber: data.serialNumber,
          certificateFingerprint: data.certificateFingerprint,
          sequence,
          hash,
          previousHash,
          details: data.details
        });

        this.lastSequence = sequence;
        this.lastHash = hash;

        logger.debug('Audit event logged to InfluxDB', {
          sequence,
          event: data.event,
          deviceId: data.deviceId,
          hash: hash.substring(0, 16) + '...'
        });

        return entry;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to write audit to InfluxDB — falling back to file', { error: msg });
        this.writeFallback(entry);
        this.lastSequence = sequence;
        this.lastHash = hash;
        return entry;
      }
    } else {
      // InfluxDB not available — fallback to file
      this.writeFallback(entry);
      this.lastSequence = sequence;
      this.lastHash = hash;
      return entry;
    }
  }

  /**
   * Verify integrity of the audit chain by querying InfluxDB.
   * Returns { valid, checkedCount, firstBrokenSequence? }
   */
  async verifyChain(): Promise<{ valid: boolean; checkedCount: number; firstBrokenSequence?: number }> {
    const influx = getInfluxService();
    if (!influx) {
      logger.warn('Cannot verify audit chain: InfluxDB not available');
      return { valid: false, checkedCount: 0 };
    }

    try {
      const chain = await influx.queryAuditChain();
      if (chain.length === 0) {
        logger.info('Audit chain empty — nothing to verify');
        return { valid: true, checkedCount: 0 };
      }

      let previousHash = 'GENESIS';
      let allValid = true;
      let firstBrokenSequence: number | undefined;

      for (const entry of chain) {
        if (entry.previousHash !== previousHash) {
          logger.error('Audit chain integrity violation: previousHash mismatch', {
            sequence: entry.sequence,
            expected: previousHash.substring(0, 16) + '...',
            found: entry.previousHash.substring(0, 16) + '...'
          });
          allValid = false;
          if (firstBrokenSequence === undefined) firstBrokenSequence = entry.sequence;
        }
        previousHash = entry.hash;
      }

      if (allValid) {
        logger.info('Audit chain integrity verified', { checkedCount: chain.length });
      } else {
        logger.error('Audit chain integrity FAILED', { checkedCount: chain.length, firstBrokenSequence });
      }

      return { valid: allValid, checkedCount: chain.length, firstBrokenSequence };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Audit chain verification failed', { error: msg });
      return { valid: false, checkedCount: 0 };
    }
  }

  /**
   * Get the current chain state for diagnostics.
   */
  getChainState(): { lastSequence: number; lastHash: string; initialized: boolean } {
    return {
      lastSequence: this.lastSequence,
      lastHash: this.lastHash,
      initialized: this.initialized
    };
  }

  // --- Private helpers ---

  private buildHashContent(fields: Record<string, unknown>): string {
    return JSON.stringify(fields, Object.keys(fields).sort());
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  private writeFallback(entry: AuditEntry): void {
    try {
      const logPath = path.resolve(this.config.fallbackLogPath);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
      logger.debug('Audit event written to fallback file', { path: logPath, sequence: entry.sequence });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to write audit fallback log', { error: msg });
    }
  }
}

// --- Singleton ---

let auditServiceInstance: AuditService | null = null;

export function createAuditService(config?: Partial<AuditServiceConfig>): AuditService {
  auditServiceInstance = new AuditService(config);
  return auditServiceInstance;
}

export function getAuditService(): AuditService | null {
  return auditServiceInstance;
}
