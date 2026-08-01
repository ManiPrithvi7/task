/**
 * OtaReleaseLog — P0 Test Suite
 *
 * P0: Merkle root/inclusion vectors + proof round-trip
 * P0: push-before-persist defect pin (leaves.push before Influx write)
 */

const mockGetInfluxService = jest.fn();
const mockLogEvent = jest.fn().mockResolvedValue(undefined);
const mockGetAuditService = jest.fn(() => ({ logEvent: mockLogEvent }));

jest.mock('@/services/influxService', () => ({
  getInfluxService: (...args: unknown[]) => mockGetInfluxService(...args),
}));

jest.mock('@/services/auditService', () => ({
  getAuditService: (...args: unknown[]) => mockGetAuditService(...args),
  AuditEventType: {
    OTA_RELEASE_LOG_ENTRY: 'OTA_RELEASE_LOG_ENTRY',
  },
}));

jest.mock('@/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import * as crypto from 'crypto';
import {
  createOtaReleaseLog,
  getOtaReleaseLog,
  type OtaReleaseLogEntry,
} from '@/services/otaReleaseLog';

/* ── Merkle helpers (mirror service semantics) ── */

function merkleHash(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function computeRootFromLeaves(leaves: string[]): string {
  if (leaves.length === 0) return merkleHash('EMPTY_TREE');
  if (leaves.length === 1) return leaves[0];
  let level = [...leaves];
  while (level.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        nextLevel.push(merkleHash(level[i] + level[i + 1]));
      } else {
        nextLevel.push(merkleHash(level[i] + level[i]));
      }
    }
    level = nextLevel;
  }
  return level[0];
}

type ProofStep = { hash: string; position: 'left' | 'right' };

function verifyInclusion(
  leafHash: string,
  proof: ProofStep[],
  expectedRoot: string,
): boolean {
  let current = leafHash;
  for (const step of proof) {
    if (step.position === 'left') {
      current = merkleHash(step.hash + current);
    } else {
      current = merkleHash(current + step.hash);
    }
  }
  return current === expectedRoot;
}

function otaLeafPreimage(
  version: string,
  sha256: string,
  objectKey: string,
  keyFingerprint: string | undefined,
  releasedAt: Date,
): string {
  return `${version}|${sha256}|${objectKey}|${keyFingerprint || ''}|${releasedAt.toISOString()}`;
}

/* ── Test Suite ── */

describe('OtaReleaseLog', () => {
  let influxMock: {
    queryOtaReleaseLeaves: jest.Mock;
    writeOtaReleaseEntry: jest.Mock;
  };

  const fixedTs = new Date('2026-07-31T12:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogEvent.mockResolvedValue(undefined);

    influxMock = {
      queryOtaReleaseLeaves: jest.fn().mockResolvedValue([]),
      writeOtaReleaseEntry: jest.fn().mockResolvedValue(undefined),
    };
    mockGetInfluxService.mockReturnValue(influxMock);
  });

  async function addRelease(
    log: ReturnType<typeof createOtaReleaseLog>,
    n: number,
  ): Promise<OtaReleaseLogEntry[]> {
    const entries: OtaReleaseLogEntry[] = [];
    for (let i = 0; i < n; i++) {
      const entry = await log.addEntry(
        `v${i}`,
        `sha${i}`.padEnd(64, '0'),
        `objects/fw-${i}.bin`,
        i % 2 === 0 ? `fp-${i}` : undefined,
        new Date(fixedTs.getTime() + i * 1000),
      );
      expect(entry).not.toBeNull();
      entries.push(entry!);
    }
    return entries;
  }

  /* ══════════════════════════════════════════════════════════════
   * P0: Merkle vectors
   * ══════════════════════════════════════════════════════════════ */

  describe('Merkle tree math', () => {
    test('empty tree root is sha256(EMPTY_TREE)', async () => {
      const log = createOtaReleaseLog();
      await log.initialize();
      expect(log.getCurrentRootHash()).toBe(merkleHash('EMPTY_TREE'));
      expect(log.getEntryCount()).toBe(0);
    });

    test('single leaf: root equals leaf, proof is empty', async () => {
      const log = createOtaReleaseLog();
      await log.initialize();

      const entry = await log.addEntry('1.0.0', 'abc', 'key', 'fp', fixedTs);
      expect(entry).not.toBeNull();
      expect(log.getCurrentRootHash()).toBe(entry!.leafHash);

      const proof = JSON.parse(entry!.inclusionProof) as ProofStep[];
      expect(proof).toEqual([]);
      expect(verifyInclusion(entry!.leafHash, proof, log.getCurrentRootHash())).toBe(true);
    });

    test('two leaves: root is hash(l0+l1)', async () => {
      const log = createOtaReleaseLog();
      await log.initialize();
      const entries = await addRelease(log, 2);

      const leaves = entries.map((e) => e.leafHash);
      expect(log.getCurrentRootHash()).toBe(merkleHash(leaves[0] + leaves[1]));
    });

    test('three leaves: odd-level self-pairing on last node', async () => {
      const log = createOtaReleaseLog();
      await log.initialize();
      const entries = await addRelease(log, 3);

      const leaves = entries.map((e) => e.leafHash);
      const level1 = [
        merkleHash(leaves[0] + leaves[1]),
        merkleHash(leaves[2] + leaves[2]),
      ];
      expect(log.getCurrentRootHash()).toBe(merkleHash(level1[0] + level1[1]));
    });

    test('known-vector roots for 1–8 leaves match independent computation', async () => {
      const log = createOtaReleaseLog();
      await log.initialize();

      for (let n = 1; n <= 8; n++) {
        const entry = await log.addEntry(
          `vec-${n}`,
          `deadbeef${n}`.padEnd(64, '0'),
          `obj-${n}`,
          undefined,
          new Date(fixedTs.getTime() + n * 60_000),
        );
        expect(entry!.index).toBe(n - 1);
      }

      const leaves = Array.from({ length: 8 }, (_, i) => {
        const preimage = otaLeafPreimage(
          `vec-${i + 1}`,
          `deadbeef${i + 1}`.padEnd(64, '0'),
          `obj-${i + 1}`,
          undefined,
          new Date(fixedTs.getTime() + (i + 1) * 60_000),
        );
        return merkleHash(preimage);
      });

      expect(log.getEntryCount()).toBe(8);
      expect(log.getCurrentRootHash()).toBe(computeRootFromLeaves(leaves));
    });

    test('inclusion proofs round-trip at each append (1–8 leaves)', async () => {
      const log = createOtaReleaseLog();
      await log.initialize();

      for (let i = 0; i < 8; i++) {
        const entry = await log.addEntry(
          `rt-${i}`,
          `sha${i}`.padEnd(64, '0'),
          `obj-${i}`,
          undefined,
          new Date(fixedTs.getTime() + i * 1000),
        );
        expect(entry).not.toBeNull();

        const proof = JSON.parse(entry!.inclusionProof) as ProofStep[];
        expect(verifyInclusion(entry!.leafHash, proof, log.getCurrentRootHash())).toBe(true);
        expect(verifyInclusion(entry!.leafHash, proof, entry!.rootHash)).toBe(true);
      }
    });

    test('odd-level proof uses self-duplicated sibling (3-leaf tree, index 2)', async () => {
      const log = createOtaReleaseLog();
      await log.initialize();
      const entries = await addRelease(log, 3);

      const proof = JSON.parse(entries[2].inclusionProof) as ProofStep[];
      expect(proof.length).toBeGreaterThan(0);
      expect(proof[0].position).toBe('right');
      expect(proof[0].hash).toBe(entries[2].leafHash);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: addEntry preimage + wiring
   * ══════════════════════════════════════════════════════════════ */

  describe('addEntry', () => {
    test('pins exact leaf preimage formula incl. empty fingerprint pipe', async () => {
      const log = createOtaReleaseLog();
      await log.initialize();

      const entry = await log.addEntry('2.1.0', 'abc123', 'fw.bin', undefined, fixedTs);
      const expectedPreimage = otaLeafPreimage('2.1.0', 'abc123', 'fw.bin', undefined, fixedTs);

      expect(entry!.leafHash).toBe(merkleHash(expectedPreimage));
      expect(influxMock.writeOtaReleaseEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          leafPreimage: expectedPreimage,
          version: '2.1.0',
          sha256: 'abc123',
          objectKey: 'fw.bin',
          keyFingerprint: '',
        }),
      );
    });

    test('Influx absent: in-memory only, still returns entry', async () => {
      mockGetInfluxService.mockReturnValue(null);
      const log = createOtaReleaseLog();

      const entry = await log.addEntry('1.0.0', 'sha', 'key', 'fp', fixedTs);
      expect(entry).not.toBeNull();
      expect(log.getEntryCount()).toBe(1);
    });

    test('fires audit logEvent fire-and-forget with truncated leafHash', async () => {
      const log = createOtaReleaseLog();
      await log.initialize();

      const entry = await log.addEntry('1.0.0', 'sha', 'key', 'fp', fixedTs);
      await new Promise((r) => setTimeout(r, 0));

      expect(mockLogEvent).toHaveBeenCalledWith({
        event: 'OTA_RELEASE_LOG_ENTRY',
        details: {
          index: 0,
          version: '1.0.0',
          sha256: 'sha',
          keyFingerprint: 'fp',
          leafHash: entry!.leafHash.substring(0, 16),
        },
      });
    });

    test('push-before-persist: Influx write failure returns null but leaf remains (defect pin)', async () => {
      influxMock.writeOtaReleaseEntry.mockRejectedValue(new Error('influx down'));
      const log = createOtaReleaseLog();
      await log.initialize();

      expect(log.getEntryCount()).toBe(0);
      const result = await log.addEntry('1.0.0', 'sha', 'key', 'fp', fixedTs);

      expect(result).toBeNull();
      expect(log.getEntryCount()).toBe(1);
      expect(log.getCurrentRootHash()).not.toBe(merkleHash('EMPTY_TREE'));
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: initialize + singleton
   * ══════════════════════════════════════════════════════════════ */

  describe('initialize', () => {
    test('loads leaves sorted by index from Influx', async () => {
      influxMock.queryOtaReleaseLeaves.mockResolvedValue([
        { index: 1, leafHash: 'leaf-b' },
        { index: 0, leafHash: 'leaf-a' },
      ]);

      const log = createOtaReleaseLog();
      await log.initialize();

      expect(log.getEntryCount()).toBe(2);
      expect(log.getCurrentRootHash()).toBe(
        computeRootFromLeaves(['leaf-a', 'leaf-b']),
      );
    });

    test('addEntry auto-initializes when called first', async () => {
      const log = createOtaReleaseLog();
      const entry = await log.addEntry('1.0.0', 'sha', 'key', undefined, fixedTs);
      expect(entry).not.toBeNull();
      expect(influxMock.queryOtaReleaseLeaves).toHaveBeenCalled();
    });
  });

  describe('singleton', () => {
    test('createOtaReleaseLog registers instance retrievable via getOtaReleaseLog', () => {
      const log = createOtaReleaseLog();
      expect(getOtaReleaseLog()).toBe(log);
    });
  });
});
