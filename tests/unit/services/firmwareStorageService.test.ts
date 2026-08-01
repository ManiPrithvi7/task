import { Readable } from 'stream';
import { OciFirmwareStorageService } from '@/services/firmwareStorageService';
import { logger } from '@/utils/logger';

const mockCreatePAR = jest.fn();
const mockHeadObject = jest.fn();
const mockGetObject = jest.fn();
const mockHeadBucket = jest.fn();

jest.mock('oci-sdk', () => ({
  objectstorage: {
    ObjectStorageClient: jest.fn().mockImplementation(() => ({
      createPreauthenticatedRequest: mockCreatePAR,
      headObject: mockHeadObject,
      getObject: mockGetObject,
      headBucket: mockHeadBucket
    })),
    models: {
      CreatePreauthenticatedRequestDetails: {
        AccessType: { ObjectWrite: 'ObjectWrite', ObjectRead: 'ObjectRead' }
      }
    }
  }
}));

jest.mock('@/services/ociAuthProvider', () => ({
  createOciAuthProvider: jest.fn(() => ({}))
}));

jest.mock('@/config/otaDefaults', () => ({
  otaOciParBaseUrl: jest.fn(() => 'https://fallback-par.example.com')
}));

jest.mock('@/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    oci: {
      namespace: 'ns',
      bucket: 'bkt',
      region: 'us-ashburn-1',
      parBaseUrl: 'https://par.example.com/'
    },
    presignedUrlTtlSec: 3600,
    ...overrides
  } as never;
}

describe('OciFirmwareStorageService', () => {
  let service: OciFirmwareStorageService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OciFirmwareStorageService(makeConfig());
  });

  describe('buildObjectKey', () => {
    it('builds firmware key from version', () => {
      expect(service.buildObjectKey('4.3.1')).toBe('firmware/4.3.1/firmware.bin');
    });

    it('sanitizes unsafe characters to underscores', () => {
      expect(service.buildObjectKey('4.3.1 beta!')).toBe('firmware/4.3.1_beta_/firmware.bin');
    });

    it('buildS3Key delegates to buildObjectKey', () => {
      expect(service.buildS3Key('4.3.1')).toBe(service.buildObjectKey('4.3.1'));
    });
  });

  describe('createPresignedPutUrl', () => {
    it('requests a PAR with ObjectWrite access and returns absolute fullPath', async () => {
      mockCreatePAR.mockResolvedValue({
        preauthenticatedRequest: { fullPath: 'https://absolute.example/x' }
      });
      const url = await service.createPresignedPutUrl('firmware/4.3.1/firmware.bin', '4.3.1');
      expect(url).toBe('https://absolute.example/x');

      const args = mockCreatePAR.mock.calls[0][0];
      expect(args.namespaceName).toBe('ns');
      expect(args.bucketName).toBe('bkt');
      expect(args.createPreauthenticatedRequestDetails.objectName).toBe('firmware/4.3.1/firmware.bin');
      expect(args.createPreauthenticatedRequestDetails.accessType).toBe('ObjectWrite');
      expect(args.createPreauthenticatedRequestDetails.name).toMatch(/^ota-upload-4\.3\.1-/);
      expect(args.createPreauthenticatedRequestDetails.name.length).toBeLessThanOrEqual(200);
      expect(args.createPreauthenticatedRequestDetails.timeExpires).toBeInstanceOf(Date);
    });

    it('joins relative fullPath with parBaseUrl (slash normalization)', async () => {
      mockCreatePAR.mockResolvedValue({ preauthenticatedRequest: { fullPath: '/x/y' } });
      expect(await service.createPresignedPutUrl('k', 'v')).toBe('https://par.example.com/x/y');
    });

    it('prefixes relative fullPath without leading slash', async () => {
      mockCreatePAR.mockResolvedValue({ preauthenticatedRequest: { fullPath: 'x/y' } });
      expect(await service.createPresignedPutUrl('k', 'v')).toBe('https://par.example.com/x/y');
    });

    it('uses accessUri when fullPath missing', async () => {
      mockCreatePAR.mockResolvedValue({ preauthenticatedRequest: { accessUri: '/a/b' } });
      expect(await service.createPresignedPutUrl('k', 'v')).toBe('https://par.example.com/a/b');
      mockCreatePAR.mockResolvedValue({ preauthenticatedRequest: { accessUri: 'a' } });
      expect(await service.createPresignedPutUrl('k', 'v')).toBe('https://par.example.com/a');
    });

    it('falls back to otaOciParBaseUrl when parBaseUrl not configured', async () => {
      const svc = new OciFirmwareStorageService(makeConfig({ oci: { namespace: 'ns', bucket: 'bkt', region: 'eu-frankfurt-1' } }));
      mockCreatePAR.mockResolvedValue({ preauthenticatedRequest: { accessUri: '/x' } });
      expect(await svc.createPresignedPutUrl('k', 'v')).toBe('https://fallback-par.example.com/x');
    });

    it('maps client errors to OciStorageError', async () => {
      mockCreatePAR.mockRejectedValue(new Error('Not Found 404'));
      await expect(service.createPresignedPutUrl('k', 'v')).rejects.toMatchObject({
        name: 'OciStorageError',
        httpStatus: 404,
        code: 'OBJECT_NOT_FOUND'
      });
    });
  });

  describe('createPresignedGetUrl', () => {
    it('requests a PAR with ObjectRead access and ota-download name', async () => {
      mockCreatePAR.mockResolvedValue({ preauthenticatedRequest: { fullPath: 'https://dl.example/x' } });
      const url = await service.createPresignedGetUrl('firmware/4.3.1/firmware.bin', '4.3.1');
      expect(url).toBe('https://dl.example/x');
      const args = mockCreatePAR.mock.calls[0][0];
      expect(args.createPreauthenticatedRequestDetails.accessType).toBe('ObjectRead');
      expect(args.createPreauthenticatedRequestDetails.name).toMatch(/^ota-download-/);
    });
  });

  describe('headObject', () => {
    it('maps contentLength and exact metadata keys', async () => {
      mockHeadObject.mockResolvedValue({
        contentLength: 12345,
        opcMeta: { 'firmware-version': '4.3.1', sha256: 'abc123' }
      });
      await expect(service.headObject('k')).resolves.toEqual({
        sizeBytes: 12345,
        firmwareVersion: '4.3.1',
        sha256: 'abc123'
      });
    });

    it('reads prefixed opc-meta- key variant', async () => {
      mockHeadObject.mockResolvedValue({ contentLength: 1, opcMeta: { 'opc-meta-firmware-version': '4.3.0' } });
      const res = await service.headObject('k');
      expect(res.firmwareVersion).toBe('4.3.0');
    });

    it('normalizes case-insensitive keys', async () => {
      mockHeadObject.mockResolvedValue({ contentLength: 1, opcMeta: { 'Opc-Meta-Firmware-Version': '4.2.9' } });
      const res = await service.headObject('k');
      expect(res.firmwareVersion).toBe('4.2.9');
    });

    it('returns undefined for missing metadata', async () => {
      mockHeadObject.mockResolvedValue({ contentLength: 0, opcMeta: {} });
      await expect(service.headObject('k')).resolves.toEqual({
        sizeBytes: 0,
        firmwareVersion: undefined,
        sha256: undefined
      });
    });

    it('maps client errors to OciStorageError', async () => {
      mockHeadObject.mockRejectedValue(new Error('NotAuthorizedOrNotFound 404'));
      await expect(service.headObject('k')).rejects.toMatchObject({
        httpStatus: 404,
        code: 'OBJECT_NOT_FOUND'
      });
    });
  });

  describe('verifySha256', () => {
    it('hashes streamed object and compares case-insensitively', async () => {
      const sha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
      mockGetObject.mockResolvedValue({ value: Readable.from([Buffer.from('hello')]) });
      expect(await service.verifySha256('k', sha256.toUpperCase())).toBe(true);
      expect(await service.verifySha256('k', '0'.repeat(64))).toBe(false);
    });

    it('produces correct hash across multiple chunks', async () => {
      const sha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
      mockGetObject.mockResolvedValue({ value: Readable.from([Buffer.from('he'), Buffer.from('llo')]) });
      expect(await service.verifySha256('k', sha256)).toBe(true);
    });
  });

  describe('getObjectStream', () => {
    it('returns res.value as Readable', async () => {
      const stream = Readable.from(['data']);
      mockGetObject.mockResolvedValue({ value: stream });
      const out = await service.getObjectStream('k');
      expect(out).toBe(stream);
    });

    it('maps empty body to OciStorageError (httpStatus 500)', async () => {
      mockGetObject.mockResolvedValue({ value: null });
      await expect(service.getObjectStream('k')).rejects.toMatchObject({
        name: 'OciStorageError',
        httpStatus: 500,
        code: 'STORAGE_ERROR'
      });
    });

    it('maps client errors to OciStorageError', async () => {
      mockGetObject.mockRejectedValue(new Error('timeout'));
      await expect(service.getObjectStream('k')).rejects.toMatchObject({
        httpStatus: 503,
        code: 'STORAGE_UNAVAILABLE'
      });
    });
  });

  describe('verifyBucketAccess', () => {
    it('headBucket success logs info and does not throw', async () => {
      mockHeadBucket.mockResolvedValue({});
      await expect(service.verifyBucketAccess()).resolves.toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith('[OTA] OCI bucket access verified', expect.anything());
    });

    it('maps headBucket failure to OciStorageError', async () => {
      mockHeadBucket.mockRejectedValue(new Error('Forbidden 403'));
      await expect(service.verifyBucketAccess()).rejects.toMatchObject({
        httpStatus: 403,
        code: 'STORAGE_FORBIDDEN'
      });
    });
  });
});
