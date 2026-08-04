/** Shared jest mocks safe to load from multiple test files (last mock wins — keep them identical). */

import * as nodeFs from 'fs';

export const mockMkdirSync = jest.fn();
export const mockAppendFileSync = jest.fn();
export const mockOciProviderCtor = jest.fn();
export const mockOciRegionFromId = jest.fn((id: string) => ({ regionId: id }));
export const mockOciCreatePAR = jest.fn();
export const mockOciHeadObject = jest.fn();
export const mockOciGetObject = jest.fn();
export const mockOciHeadBucket = jest.fn();

export function mockLoggerModule(): typeof import('@/utils/logger') {
  const logger = {
    level: 'info',
    transports: [{ level: 'info' }],
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  return {
    logger: logger as unknown as typeof import('@/utils/logger').logger,
    configureLogger: jest.fn((level: string) => {
      logger.level = level?.trim() || 'info';
      for (const transport of logger.transports) {
        transport.level = logger.level;
      }
    }),
  };
}

export function mockInfluxDbClientModule(): typeof import('@influxdata/influxdb-client') {
  const mockWriteApi = {
    writePoint: jest.fn(),
    writeRecords: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    useDefaultTags: jest.fn(),
  };

  return {
    InfluxDB: jest.fn().mockImplementation(() => ({
      getWriteApi: jest.fn().mockReturnValue(mockWriteApi),
      getQueryApi: jest.fn().mockReturnValue({ queryRows: jest.fn() }),
    })),
    Point: jest.fn().mockImplementation(() => ({
      tag: jest.fn().mockReturnThis(),
      stringField: jest.fn().mockReturnThis(),
      intField: jest.fn().mockReturnThis(),
      floatField: jest.fn().mockReturnThis(),
      booleanField: jest.fn().mockReturnThis(),
      timestamp: jest.fn().mockReturnThis(),
      toLineProtocol: jest.fn().mockReturnValue('m,tag=a v=1'),
    })),
    WriteApi: jest.fn(),
    QueryApi: jest.fn(),
  } as unknown as typeof import('@influxdata/influxdb-client');
}

export function mockOciSdkModule(): Record<string, unknown> {
  return {
    common: {
      SimpleAuthenticationDetailsProvider: class {
        constructor(...args: unknown[]) {
          mockOciProviderCtor(...args);
        }
      },
      Region: { fromRegionId: (id: string) => mockOciRegionFromId(id) },
    },
    objectstorage: {
      ObjectStorageClient: jest.fn().mockImplementation(() => ({
        createPreauthenticatedRequest: mockOciCreatePAR,
        headObject: mockOciHeadObject,
        getObject: mockOciGetObject,
        headBucket: mockOciHeadBucket,
      })),
      models: {
        CreatePreauthenticatedRequestDetails: {
          AccessType: { ObjectWrite: 'ObjectWrite', ObjectRead: 'ObjectRead' },
        },
      },
    },
  };
}

export function mockFsModule(): typeof import('fs') {
  return {
    ...nodeFs,
    mkdirSync: (...args: Parameters<typeof nodeFs.mkdirSync>) => mockMkdirSync(...args),
    appendFileSync: (...args: Parameters<typeof nodeFs.appendFileSync>) =>
      mockAppendFileSync(...args),
  };
}
