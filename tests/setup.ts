// ponytail: Bun test preload — path aliases come from tsconfig.json paths.
import {
  mockInfluxDbClientModule,
  mockLoggerModule,
  mockOciSdkModule,
} from './helpers/moduleMocks';

jest.mock('@/utils/logger', () => mockLoggerModule());
jest.mock('@influxdata/influxdb-client', () => mockInfluxDbClientModule());
jest.mock('oci-sdk', () => mockOciSdkModule());
