/**
 * TransparencyLog — P0 Test Suite
 *
 * P0: Merkle vectors + verifyInclusion round-trip
 * P0: push-before-persist defect pin
 * P0: verifyConsistency length-gated root check defect pin
 */

const mockGetInfluxService = jest.fn();

jest.mock('@/services/influxService', () => ({
  getInfluxService: (...args: unknown[]) => mockGetInfluxService(...args),
}));


import * as crypto from 'crypto';
import {
  createTransparencyLog,
  getTransparencyLog,
  type TransparencyProof,
} from '@/services/transparencyLog';

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

function certLeafPreimage(
  certFingerprint: string,
  serialNumber: string,
  cn: string,
  issuedAt: Date,
): string {
  return `${certFingerprint}|${serialNumber}|${cn}|${issuedAt.toISOString()}`;
}

/* ── Test Suite ── */

describe('TransparencyLog', () => {
  let influxMock: {
    queryTransparencyLeaves: jest.Mock;
    writeTransparencyEntry: jest.Mock;
  };

  const fixedTs = new Date('2026-07-31T12:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();

    influxMock = {
      queryTransparencyLeaves: jest.fn().mockResolvedValue([]),
      writeTransparencyEntry: jest.fn().mockResolvedValue(undefined),
    };
    mockGetInfluxService.mockReturnValue(influxMock);
  });

  async function addCert(
    log: ReturnType<typeof createTransparencyLog>,
    n: number,
  ): Promise<TransparencyProof[]> {
    const proofs: TransparencyProof[] = [];
    for (let i = 0; i < n; i++) {
      const proof = await log.addEntry(
        `fp-${i}`,
        `serial-${i}`,
        `device-${i}.example.com`,
        `dev-${i}`,
        new Date(fixedTs.getTime() + i * 1000),
      );
      expect(proof).not.toBeNull();
      proofs.push(proof!);
    }
    return proofs;
  }

  /* ══════════════════════════════════════════════════════════════
   * P0: Merkle vectors + verifyInclusion
   * ══════════════════════════════════════════════════════════════ */

  describe('Merkle tree math', () => {
    test('empty tree root is sha256(EMPTY_TREE)', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      expect(log.getCurrentRootHash()).toBe(merkleHash('EMPTY_TREE'));
    });

    test('single leaf: root equals leaf, empty proof verifies', async () => {
      const log = createTransparencyLog();
      await log.initialize();

      const proof = await log.addEntry('fp', 'sn', 'cn.example.com', 'dev-1', fixedTs);
      expect(proof!.inclusionProof).toEqual([]);
      expect(
        log.verifyInclusion(proof!.leafHash, proof!.inclusionProof, log.getCurrentRootHash()),
      ).toBe(true);
    });

    test('two leaves: root is hash(l0+l1)', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      const proofs = await addCert(log, 2);
      const leaves = proofs.map((p) => p.leafHash);
      expect(log.getCurrentRootHash()).toBe(merkleHash(leaves[0] + leaves[1]));
    });

    test('three leaves: odd-level self-pairing', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      const proofs = await addCert(log, 3);
      const leaves = proofs.map((p) => p.leafHash);
      const level1 = [
        merkleHash(leaves[0] + leaves[1]),
        merkleHash(leaves[2] + leaves[2]),
      ];
      expect(log.getCurrentRootHash()).toBe(merkleHash(level1[0] + level1[1]));
    });

    test('verifyInclusion round-trip at each append (1–8 leaves)', async () => {
      const log = createTransparencyLog();
      await log.initialize();

      for (let i = 0; i < 8; i++) {
        const proof = await log.addEntry(
          `fp-${i}`,
          `serial-${i}`,
          `device-${i}.example.com`,
          `dev-${i}`,
          new Date(fixedTs.getTime() + i * 1000),
        );
        expect(proof).not.toBeNull();
        expect(
          log.verifyInclusion(proof!.leafHash, proof!.inclusionProof, log.getCurrentRootHash()),
        ).toBe(true);
        expect(
          log.verifyInclusion(proof!.leafHash, proof!.inclusionProof, proof!.rootHash),
        ).toBe(true);
      }
    });

    test('verifyInclusion rejects tampered sibling hash', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      const proofs = await addCert(log, 4);
      const target = proofs[2];
      const tampered = target.inclusionProof.map((step, i) =>
        i === 0 ? { ...step, hash: '0'.repeat(64) } : step,
      );
      expect(
        log.verifyInclusion(target.leafHash, tampered, log.getCurrentRootHash()),
      ).toBe(false);
    });

    test('verifyInclusion rejects wrong position', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      const proofs = await addCert(log, 4);
      const target = proofs[1];
      const flipped = target.inclusionProof.map((step) => ({
        ...step,
        position: step.position === 'left' ? ('right' as const) : ('left' as const),
      }));
      expect(
        log.verifyInclusion(target.leafHash, flipped, log.getCurrentRootHash()),
      ).toBe(false);
    });

    test('verifyInclusion rejects mismatched expectedRoot', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      const proof = await log.addEntry('fp', 'sn', 'cn', 'dev', fixedTs);
      expect(log.verifyInclusion(proof!.leafHash, proof!.inclusionProof, 'bad-root')).toBe(
        false,
      );
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: addEntry + disabled config
   * ══════════════════════════════════════════════════════════════ */

  describe('addEntry', () => {
    test('disabled config returns null without initialize', async () => {
      const log = createTransparencyLog({ enabled: false });
      const result = await log.addEntry('fp', 'sn', 'cn', 'dev', fixedTs);
      expect(result).toBeNull();
      expect(influxMock.queryTransparencyLeaves).not.toHaveBeenCalled();
    });

    test('pins exact leaf preimage pipe layout', async () => {
      const log = createTransparencyLog();
      await log.initialize();

      const proof = await log.addEntry('aa:bb:cc', 'SN123', 'device.example.com', 'dev-1', fixedTs);
      const expectedPreimage = certLeafPreimage('aa:bb:cc', 'SN123', 'device.example.com', fixedTs);

      expect(proof!.leafHash).toBe(merkleHash(expectedPreimage));
      expect(influxMock.writeTransparencyEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          leafPreimage: expectedPreimage,
          certFingerprint: 'aa:bb:cc',
          serialNumber: 'SN123',
          cn: 'device.example.com',
          deviceId: 'dev-1',
        }),
      );
    });

    test('push-before-persist: Influx write failure returns null but leaf remains (defect pin)', async () => {
      influxMock.writeTransparencyEntry.mockRejectedValue(new Error('influx down'));
      const log = createTransparencyLog();
      await log.initialize();

      const result = await log.addEntry('fp', 'sn', 'cn', 'dev', fixedTs);
      expect(result).toBeNull();
      expect(log.getEntryCount()).toBe(1);
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * P0: verifyConsistency
   * ══════════════════════════════════════════════════════════════ */

  describe('verifyConsistency', () => {
    test('returns error when Influx unavailable', async () => {
      mockGetInfluxService.mockReturnValue(null);
      const log = createTransparencyLog();
      await log.initialize();

      const result = await log.verifyConsistency();
      expect(result).toEqual({
        valid: false,
        entryCount: 0,
        errors: ['InfluxDB not available'],
      });
    });

    test('detects index gap', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      await addCert(log, 1);

      influxMock.queryTransparencyLeaves.mockResolvedValue([
        { index: 1, leafHash: 'orphan-leaf' },
      ]);

      const result = await log.verifyConsistency();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /Index gap/.test(e))).toBe(true);
    });

    test('detects root mismatch when memory and Influx counts match', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      const proofs = await addCert(log, 2);

      influxMock.queryTransparencyLeaves.mockResolvedValue([
        { index: 0, leafHash: proofs[0].leafHash },
        { index: 1, leafHash: 'wrong-leaf-hash' },
      ]);

      const result = await log.verifyConsistency();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /Root hash mismatch/.test(e))).toBe(true);
    });

    test('skips root check when memory and Influx leaf counts differ (defect pin)', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      await addCert(log, 2);

      influxMock.queryTransparencyLeaves.mockResolvedValue([
        { index: 0, leafHash: 'only-one-leaf-from-influx' },
      ]);

      const result = await log.verifyConsistency();
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.entryCount).toBe(1);
    });

    test('valid path when Influx leaves match in-memory tree', async () => {
      const log = createTransparencyLog();
      await log.initialize();
      const proofs = await addCert(log, 3);

      influxMock.queryTransparencyLeaves.mockResolvedValue(
        proofs.map((p, i) => ({ index: i, leafHash: p.leafHash })),
      );

      const result = await log.verifyConsistency();
      expect(result).toEqual({ valid: true, entryCount: 3, errors: [] });
    });
  });

  /* ══════════════════════════════════════════════════════════════
   * initialize + singleton
   * ══════════════════════════════════════════════════════════════ */

  describe('initialize', () => {
    test('disabled sets initialized without querying Influx', async () => {
      const log = createTransparencyLog({ enabled: false });
      await log.initialize();
      expect(influxMock.queryTransparencyLeaves).not.toHaveBeenCalled();
      expect(log.getEntryCount()).toBe(0);
    });

    test('loads leaves sorted by index', async () => {
      influxMock.queryTransparencyLeaves.mockResolvedValue([
        { index: 1, leafHash: 'b' },
        { index: 0, leafHash: 'a' },
      ]);

      const log = createTransparencyLog();
      await log.initialize();

      expect(log.getCurrentRootHash()).toBe(computeRootFromLeaves(['a', 'b']));
    });
  });

  describe('singleton', () => {
    test('createTransparencyLog registers instance retrievable via getTransparencyLog', () => {
      const log = createTransparencyLog();
      expect(getTransparencyLog()).toBe(log);
    });
  });
});
