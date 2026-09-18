// ponytail: Bun test preload — path aliases come from tsconfig.json paths.
import {
  mockInfluxDbClientModule,
  mockLoggerModule,
  mockOciSdkModule,
} from './helpers/moduleMocks';
import { clearStimTestOtaEnv } from './helpers/clearStimTestOtaEnv';

jest.mock('@/utils/logger', () => mockLoggerModule());
jest.mock('@influxdata/influxdb-client', () => mockInfluxDbClientModule());
jest.mock('oci-sdk', () => mockOciSdkModule());

beforeEach(() => {
  clearStimTestOtaEnv();
});
