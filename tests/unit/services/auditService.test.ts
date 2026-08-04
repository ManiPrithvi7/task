/**
 * AuditService — Comprehensive Test Suite
 *
 * Priority coverage:
 *   P0: logEvent hash chaining, initialize load-from-Influx
 *   P1: verifyChain integrity matrix, fallback file write
 *   P2: singleton lifecycle, getChainState, config defaults
 *
 * Bugs asserted fixed:
 *   #1: details content included in hash preimage (Object.fromEntries sort)
 *   #2: verifyChain recomputes hashes when hashPreimage is present
 *   #3: double-init guard preserves in-memory chain head
 */

import { mockAppendFileSync, mockFsModule, mockMkdirSync } from '../../helpers/moduleMocks';

const mockGetInfluxService = jest.fn();

jest.mock('@/services/influxService', () => ({
  getInfluxService: (...args: unknown[]) => mockGetInfluxService(...args),
}));

jest.mock('fs', () => mockFsModule());

import * as crypto from 'crypto';
import * as path from 'path';
import {
  createAuditService,
  getAuditService,
  AuditEventType,
  AuditLogData,
} from '@/services/auditService';

/* ── Helpers ── */

/** Replicates fixed AuditService.buildHashContent */
function buildExpectedPreimage(fields: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(fields).sort()));
}

/** Computes expected SHA-256 hex digest */
function expectedSha256(preimage: string): string {
  return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/* ── Test Suite ── */

describe('AuditService', () => {
  let influxMock: {
    queryLatestAuditEntry: jest.Mock;
    writeAuditEvent: jest.Mock;
    queryAuditChain: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    influxMock = {
      queryLatestAuditEntry: jest.fn(),
      writeAuditEvent: jest.fn(),
      queryAuditChain: jest.fn(),
    };

    // Default: InfluxDB unavailable, fs succeeds
    mockGetInfluxService.mockReturnValue(null);
    mockMkdirSync.mockReturnValue(undefined);
    mockAppendFileSync.mockReturnValue(undefined);
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: initialize
   * ══════════════════════════════════════════════════════════════ */

  describe('initialize', () => {
    test('loads lastSequence and lastHash from InfluxDB when latest entry exists', async () => {
      influxMock.queryLatestAuditEntry.mockResolvedValue({
        sequence: 42,
        hash: 'abc123def456',
      });
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      expect(service.getChainState()).toEqual({
        lastSequence: 42,
        lastHash: 'abc123def456',
        initialized: true,
      });
    });

    test('stays at genesis when InfluxDB returns null', async () => {
      influxMock.queryLatestAuditEntry.mockResolvedValue(null);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      expect(service.getChainState()).toEqual({
        lastSequence: 0,
        lastHash: 'GENESIS',
        initialized: true,
      });
    });

    test('stays at genesis when InfluxDB is not available (null)', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      expect(service.getChainState()).toEqual({
        lastSequence: 0,
        lastHash: 'GENESIS',
        initialized: true,
      });
    });

    test('sets initialized=true even when queryLatestAuditEntry throws', async () => {
      influxMock.queryLatestAuditEntry.mockRejectedValue(
        new Error('connection refused'),
      );
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      expect(service.getChainState().initialized).toBe(true);
      expect(service.getChainState().lastSequence).toBe(0);
      expect(service.getChainState().lastHash).toBe('GENESIS');
    });

    test('second initialize() is a no-op — preserves in-memory state (Bug #3 fixed)', async () => {
      influxMock.queryLatestAuditEntry.mockResolvedValue({
        sequence: 10,
        hash: 'hash10',
      });
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();
      expect(service.getChainState().lastSequence).toBe(10);

      // DB state changed between calls — must NOT overwrite
      influxMock.queryLatestAuditEntry.mockResolvedValue({
        sequence: 25,
        hash: 'hash25',
      });
      await service.initialize();

      expect(service.getChainState().lastSequence).toBe(10);
      expect(service.getChainState().lastHash).toBe('hash10');
      expect(influxMock.queryLatestAuditEntry).toHaveBeenCalledTimes(1);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: logEvent — core hash chaining logic
   * ══════════════════════════════════════════════════════════════ */

  describe('logEvent', () => {
    test('auto-initializes when called before initialize()', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      // intentionally skip initialize()

      const entry = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
        deviceId: 'dev-1',
      });

      expect(entry).not.toBeNull();
      expect(entry!.sequence).toBe(1);
      expect(service.getChainState().initialized).toBe(true);
    });

    test('sequence is monotonic — two entries yield 1 then 2', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      const e1 = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });
      const e2 = await service.logEvent({
        event: AuditEventType.CERTIFICATE_REVOKED,
      });

      expect(e1!.sequence).toBe(1);
      expect(e2!.sequence).toBe(2);
    });

    test('hash chain: entry1.previousHash === GENESIS, entry2.previousHash === entry1.hash', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      const e1 = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });
      const e2 = await service.logEvent({
        event: AuditEventType.CERTIFICATE_REVOKED,
      });

      expect(e1!.previousHash).toBe('GENESIS');
      expect(e2!.previousHash).toBe(e1!.hash);
    });

    test('hash is deterministic SHA-256 of sorted-key preimage', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      const data: AuditLogData = {
        event: AuditEventType.CERTIFICATE_ISSUED,
        deviceId: 'dev-001',
        serialNumber: 'SN-123',
        details: { reason: 'initial' },
      };

      const entry = await service.logEvent(data);
      expect(entry).not.toBeNull();

      const fields = {
        timestamp: entry!.timestamp.toISOString(),
        event: data.event,
        deviceId: data.deviceId || null,
        userId: data.userId || null,
        orderId: data.orderId || null,
        batchId: data.batchId || null,
        serialNumber: data.serialNumber || null,
        certificateFingerprint: data.certificateFingerprint || null,
        details: data.details || {},
        previousHash: 'GENESIS',
      };

      expect(entry!.hash).toBe(
        expectedSha256(buildExpectedPreimage(fields)),
      );
    });

    test('preimage is deterministic regardless of object key insertion order', () => {
      const fieldsA = {
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'X',
        deviceId: 'd',
        userId: null,
        orderId: null,
        batchId: null,
        serialNumber: null,
        certificateFingerprint: null,
        details: {},
        previousHash: 'GENESIS',
      };
      const fieldsB = {
        previousHash: 'GENESIS',
        details: {},
        certificateFingerprint: null,
        serialNumber: null,
        batchId: null,
        orderId: null,
        userId: null,
        deviceId: 'd',
        event: 'X',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      expect(buildExpectedPreimage(fieldsA)).toBe(
        buildExpectedPreimage(fieldsB),
      );
    });

    test('hashChainEnabled:false produces 32-char random hex (not sha256 of preimage)', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService({ hashChainEnabled: false });
      await service.initialize();

      const e1 = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });
      const e2 = await service.logEvent({
        event: AuditEventType.CERTIFICATE_REVOKED,
      });

      expect(e1!.hash).toMatch(/^[0-9a-f]{32}$/);
      expect(e2!.hash).toMatch(/^[0-9a-f]{32}$/);
      expect(e1!.hash).not.toBe(e2!.hash);
    });

    test('writes correct payload to InfluxDB on success', async () => {
      influxMock.queryLatestAuditEntry.mockResolvedValue(null);
      influxMock.writeAuditEvent.mockResolvedValue(undefined);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      const data: AuditLogData = {
        event: AuditEventType.CERTIFICATE_ISSUED,
        deviceId: 'dev-001',
        userId: 'user-1',
        serialNumber: 'SN-123',
        certificateFingerprint: 'fp-abc',
        details: { reason: 'test' },
      };

      const entry = await service.logEvent(data);

      expect(influxMock.writeAuditEvent).toHaveBeenCalledTimes(1);
      const payload = influxMock.writeAuditEvent.mock.calls[0][0];
      expect(payload).toMatchObject({
        event: 'CERTIFICATE_ISSUED',
        deviceId: 'dev-001',
        userId: 'user-1',
        serialNumber: 'SN-123',
        certificateFingerprint: 'fp-abc',
        sequence: 1,
        previousHash: 'GENESIS',
        details: { reason: 'test' },
      });
      expect(payload.hash).toBe(entry!.hash);
      expect(payload.hashPreimage).toBeDefined();
      expect(typeof payload.hashPreimage).toBe('string');
      expect(payload.hashPreimage).toContain('"reason":"test"');

      // State advances
      expect(service.getChainState().lastSequence).toBe(1);
      expect(service.getChainState().lastHash).toBe(entry!.hash);
    });

    test('defaults deviceId to "system" in InfluxDB write when absent', async () => {
      influxMock.queryLatestAuditEntry.mockResolvedValue(null);
      influxMock.writeAuditEvent.mockResolvedValue(undefined);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });

      expect(influxMock.writeAuditEvent.mock.calls[0][0].deviceId).toBe(
        'system',
      );
    });

    test('falls back to file on InfluxDB write failure — still advances state', async () => {
      influxMock.queryLatestAuditEntry.mockResolvedValue(null);
      influxMock.writeAuditEvent.mockRejectedValue(
        new Error('write timeout'),
      );
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService({
        fallbackLogPath: '/tmp/audit-test.log',
      });
      await service.initialize();

      const entry = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });

      expect(entry).not.toBeNull();
      expect(entry!.sequence).toBe(1);

      const resolved = path.resolve('/tmp/audit-test.log');
      expect(mockMkdirSync).toHaveBeenCalledWith(
        path.dirname(resolved),
        { recursive: true },
      );
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        resolved,
        JSON.stringify(entry) + '\n',
        { encoding: 'utf8' },
      );

      // State still advances despite InfluxDB failure
      expect(service.getChainState().lastSequence).toBe(1);
      expect(service.getChainState().lastHash).toBe(entry!.hash);
    });

    test('falls back to file when InfluxDB is not available', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService({
        fallbackLogPath: '/tmp/audit-test.log',
      });
      await service.initialize();

      const entry = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });

      expect(entry).not.toBeNull();
      expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
      expect(mockAppendFileSync).toHaveBeenCalledWith(
        path.resolve('/tmp/audit-test.log'),
        JSON.stringify(entry) + '\n',
        { encoding: 'utf8' },
      );
    });

    test('writeFallback failure does not throw — logs warn only', async () => {
      mockGetInfluxService.mockReturnValue(null);
      mockAppendFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const service = createAuditService();
      await service.initialize();

      // Must not throw
      const entry = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });

      expect(entry).not.toBeNull();
      expect(entry!.sequence).toBe(1);
      expect(service.getChainState().lastSequence).toBe(1);
    });

    test('defaults details to {} on entry when not provided', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      const entry = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });

      expect(entry!.details).toEqual({});
    });

    test('optional identity fields are undefined on entry when not provided', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      const entry = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });

      expect(entry!.deviceId).toBeUndefined();
      expect(entry!.userId).toBeUndefined();
      expect(entry!.orderId).toBeUndefined();
      expect(entry!.batchId).toBeUndefined();
      expect(entry!.serialNumber).toBeUndefined();
      expect(entry!.certificateFingerprint).toBeUndefined();
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P1: verifyChain — integrity verification
   * ══════════════════════════════════════════════════════════════ */

  describe('verifyChain', () => {
    test('returns {valid:false, checkedCount:0} when InfluxDB not available', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      const result = await service.verifyChain();

      expect(result).toEqual({ valid: false, checkedCount: 0 });
    });

    test('returns {valid:true, checkedCount:0} for empty chain', async () => {
      influxMock.queryAuditChain.mockResolvedValue([]);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      const result = await service.verifyChain();

      expect(result).toEqual({ valid: true, checkedCount: 0 });
    });

    test('validates contiguous chain starting from GENESIS', async () => {
      influxMock.queryAuditChain.mockResolvedValue([
        { sequence: 1, hash: 'h1', previousHash: 'GENESIS' },
        { sequence: 2, hash: 'h2', previousHash: 'h1' },
        { sequence: 3, hash: 'h3', previousHash: 'h2' },
      ]);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      const result = await service.verifyChain();

      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(3);
      expect(result.firstBrokenSequence).toBeUndefined();
    });

    test('detects mid-chain previousHash mismatch', async () => {
      influxMock.queryAuditChain.mockResolvedValue([
        { sequence: 1, hash: 'h1', previousHash: 'GENESIS' },
        { sequence: 2, hash: 'h2', previousHash: 'h1' },
        { sequence: 3, hash: 'h3', previousHash: 'TAMPERED' },
        { sequence: 4, hash: 'h4', previousHash: 'h3' },
      ]);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      const result = await service.verifyChain();

      expect(result.valid).toBe(false);
      expect(result.checkedCount).toBe(4);
      expect(result.firstBrokenSequence).toBe(3);
    });

    test('detects broken chain at first entry (previousHash !== GENESIS)', async () => {
      influxMock.queryAuditChain.mockResolvedValue([
        { sequence: 1, hash: 'h1', previousHash: 'NOT_GENESIS' },
        { sequence: 2, hash: 'h2', previousHash: 'h1' },
      ]);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      const result = await service.verifyChain();

      expect(result.valid).toBe(false);
      expect(result.firstBrokenSequence).toBe(1);
    });

    test('returns {valid:false, checkedCount:0} when queryAuditChain throws', async () => {
      influxMock.queryAuditChain.mockRejectedValue(
        new Error('query failed'),
      );
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      const result = await service.verifyChain();

      expect(result).toEqual({ valid: false, checkedCount: 0 });
    });

    test('legacy entries without hashPreimage still verify via linkage only', async () => {
      // No hashPreimage → skip recomputation; linkage intact → valid
      influxMock.queryAuditChain.mockResolvedValue([
        { sequence: 1, hash: 'random1', previousHash: 'GENESIS' },
        { sequence: 2, hash: 'random2', previousHash: 'random1' },
      ]);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      const result = await service.verifyChain();

      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(2);
    });

    test('detects hash recomputation mismatch when hashPreimage present (Bug #2 fixed)', async () => {
      const preimage = '{"event":"TEST","previousHash":"GENESIS"}';
      const correctHash = expectedSha256(preimage);

      influxMock.queryAuditChain.mockResolvedValue([
        {
          sequence: 1,
          hash: 'tampered-hash-not-matching',
          previousHash: 'GENESIS',
          hashPreimage: preimage,
        },
        {
          sequence: 2,
          hash: 'h2',
          previousHash: 'tampered-hash-not-matching',
          hashPreimage: '{"event":"TEST2","previousHash":"tampered-hash-not-matching"}',
        },
      ]);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      const result = await service.verifyChain();

      expect(result.valid).toBe(false);
      expect(result.firstBrokenSequence).toBe(1);
      expect(result.checkedCount).toBe(2);
      // Sanity: correct hash would differ from tampered
      expect(correctHash).not.toBe('tampered-hash-not-matching');
    });

    test('validates chain when hashPreimage recomputation matches stored hash', async () => {
      const preimage1 = buildExpectedPreimage({
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'CERTIFICATE_ISSUED',
        deviceId: null,
        userId: null,
        orderId: null,
        batchId: null,
        serialNumber: null,
        certificateFingerprint: null,
        details: { reason: 'ok' },
        previousHash: 'GENESIS',
      });
      const hash1 = expectedSha256(preimage1);

      const preimage2 = buildExpectedPreimage({
        timestamp: '2024-01-01T00:00:01.000Z',
        event: 'CERTIFICATE_REVOKED',
        deviceId: null,
        userId: null,
        orderId: null,
        batchId: null,
        serialNumber: null,
        certificateFingerprint: null,
        details: {},
        previousHash: hash1,
      });
      const hash2 = expectedSha256(preimage2);

      influxMock.queryAuditChain.mockResolvedValue([
        {
          sequence: 1,
          hash: hash1,
          previousHash: 'GENESIS',
          hashPreimage: preimage1,
        },
        {
          sequence: 2,
          hash: hash2,
          previousHash: hash1,
          hashPreimage: preimage2,
        },
      ]);
      mockGetInfluxService.mockReturnValue(influxMock as never);

      const service = createAuditService();
      await service.initialize();

      const result = await service.verifyChain();

      expect(result.valid).toBe(true);
      expect(result.checkedCount).toBe(2);
      expect(result.firstBrokenSequence).toBeUndefined();
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P1: Fallback file behavior
   * ══════════════════════════════════════════════════════════════ */

  describe('fallback file', () => {
    test('creates parent directory recursively before writing', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService({
        fallbackLogPath: '/tmp/deep/nested/audit.log',
      });
      await service.initialize();

      await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });

      expect(mockMkdirSync).toHaveBeenCalledWith(
        path.dirname(path.resolve('/tmp/deep/nested/audit.log')),
        { recursive: true },
      );
    });

    test('appends entry as JSON + newline in UTF-8', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService({
        fallbackLogPath: '/tmp/audit.log',
      });
      await service.initialize();

      const entry = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        path.resolve('/tmp/audit.log'),
        JSON.stringify(entry) + '\n',
        { encoding: 'utf8' },
      );
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P2: getChainState
   * ══════════════════════════════════════════════════════════════ */

  describe('getChainState', () => {
    test('returns genesis state before any events are logged', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      expect(service.getChainState()).toEqual({
        lastSequence: 0,
        lastHash: 'GENESIS',
        initialized: true,
      });
    });

    test('reflects state after multiple logEvent calls', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });
      const e2 = await service.logEvent({
        event: AuditEventType.CERTIFICATE_REVOKED,
      });

      expect(service.getChainState()).toEqual({
        lastSequence: 2,
        lastHash: e2!.hash,
        initialized: true,
      });
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P2: Singleton lifecycle & config
   * ══════════════════════════════════════════════════════════════ */

  describe('singleton lifecycle', () => {
    test('createAuditService returns instance accessible via getAuditService', () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      expect(getAuditService()).toBe(service);
    });

    test('re-calling createAuditService replaces singleton', () => {
      mockGetInfluxService.mockReturnValue(null);

      const s1 = createAuditService();
      const s2 = createAuditService();

      expect(s1).not.toBe(s2);
      expect(getAuditService()).toBe(s2);
    });

    test('applies config defaults when no config provided', () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      const state = service.getChainState();

      expect(state.initialized).toBe(false);
      expect(state.lastSequence).toBe(0);
      expect(state.lastHash).toBe('GENESIS');
    });

    test('accepts custom config overrides', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService({
        fallbackLogPath: '/custom/path/audit.log',
        hashChainEnabled: false,
        hsmSigningEnabled: true,
        hsmSigningInterval: 50,
      });

      await service.initialize();

      const entry = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
      });

      // hashChainEnabled: false → 32-char random hex
      expect(entry!.hash).toMatch(/^[0-9a-f]{32}$/);

      // Custom fallback path used
      expect(mockMkdirSync).toHaveBeenCalledWith(
        path.dirname(path.resolve('/custom/path/audit.log')),
        { recursive: true },
      );
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * Bug #1 fixed: details content included in hash preimage
   * ══════════════════════════════════════════════════════════════ */

  describe('Bug #1 fixed: details content included in hash preimage', () => {
    test('Object.fromEntries sort preserves nested details keys', () => {
      const fieldsWithContent = {
        timestamp: '2024-01-01T00:00:00.000Z',
        event: 'TEST',
        deviceId: null,
        userId: null,
        orderId: null,
        batchId: null,
        serialNumber: null,
        certificateFingerprint: null,
        details: { critical: 'evidence', count: 42 },
        previousHash: 'GENESIS',
      };

      const fieldsEmpty = {
        ...fieldsWithContent,
        details: {},
      };

      const preimage1 = buildExpectedPreimage(fieldsWithContent);
      const preimage2 = buildExpectedPreimage(fieldsEmpty);

      expect(preimage1).not.toBe(preimage2);
      expect(preimage1).toContain('"critical"');
      expect(preimage1).toContain('"evidence"');
      expect(preimage1).toContain('"count":42');
      expect(preimage1).not.toContain('"details":{}');
    });

    test('logEvent produces different hashes for different details content', async () => {
      mockGetInfluxService.mockReturnValue(null);

      const service = createAuditService();
      await service.initialize();

      // Freeze time so timestamps match
      const fixedDate = new Date('2024-06-15T12:00:00.000Z');
      jest.spyOn(global, 'Date').mockImplementation(() => fixedDate as unknown as Date);

      const e1 = await service.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
        details: { reason: 'alpha' },
      });

      // Reset chain for second compare via new service with same timestamp
      const service2 = createAuditService();
      await service2.initialize();

      const e2 = await service2.logEvent({
        event: AuditEventType.CERTIFICATE_ISSUED,
        details: { reason: 'beta' },
      });

      expect(e1!.hash).not.toBe(e2!.hash);

      (global.Date as unknown as jest.SpyInstance).mockRestore();
    });
  });
});
