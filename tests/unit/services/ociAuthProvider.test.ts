import { hasOciEnvCredentials, createOciAuthProvider } from '@/services/ociAuthProvider';
import { common } from 'oci-sdk';
import { mockOciProviderCtor, mockOciRegionFromId } from '../../helpers/moduleMocks';

const OCI_ENV_KEYS = [
  'OCI_API_PRIVATE_KEY',
  'OCI_API_PRIVATE_KEY_BASE64',
  'OCI_PRIVATE_KEY',
  'OCI_TENANCY_OCID',
  'OCI_USER_OCID',
  'OCI_FINGERPRINT'
] as const;

const PEM = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
const PEM_ESCAPED = PEM.replace(/\n/g, '\\n');

function setEnv(values: Partial<Record<(typeof OCI_ENV_KEYS)[number], string>>) {
  for (const key of OCI_ENV_KEYS) {
    if (key in values) process.env[key] = values[key] as string;
    else delete process.env[key];
  }
}

describe('ociAuthProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setEnv({});
  });

  afterAll(() => {
    setEnv({});
  });

  describe('hasOciEnvCredentials', () => {
    it('true when all envs present with inline private key', () => {
      setEnv({
        OCI_TENANCY_OCID: 'ocid1.tenancy.1',
        OCI_USER_OCID: 'ocid1.user.1',
        OCI_FINGERPRINT: 'fp',
        OCI_API_PRIVATE_KEY: PEM_ESCAPED
      });
      expect(hasOciEnvCredentials()).toBe(true);
    });

    it('true when private key provided as base64', () => {
      setEnv({
        OCI_TENANCY_OCID: 'ocid1.tenancy.1',
        OCI_USER_OCID: 'ocid1.user.1',
        OCI_FINGERPRINT: 'fp',
        OCI_API_PRIVATE_KEY_BASE64: Buffer.from(PEM).toString('base64')
      });
      expect(hasOciEnvCredentials()).toBe(true);
    });

    it('true when legacy OCI_PRIVATE_KEY used', () => {
      setEnv({
        OCI_TENANCY_OCID: 'ocid1.tenancy.1',
        OCI_USER_OCID: 'ocid1.user.1',
        OCI_FINGERPRINT: 'fp',
        OCI_PRIVATE_KEY: PEM_ESCAPED
      });
      expect(hasOciEnvCredentials()).toBe(true);
    });

    it('false when any required key missing', () => {
      setEnv({
        OCI_TENANCY_OCID: 'ocid1.tenancy.1',
        OCI_USER_OCID: 'ocid1.user.1',
        OCI_FINGERPRINT: 'fp'
      });
      expect(hasOciEnvCredentials()).toBe(false);
    });

    it('PINNED: base64 decode is lenient — garbage input still yields a key (no throw)', () => {
      setEnv({
        OCI_TENANCY_OCID: 'ocid1.tenancy.1',
        OCI_USER_OCID: 'ocid1.user.1',
        OCI_FINGERPRINT: 'fp',
        OCI_API_PRIVATE_KEY_BASE64: '!!!not-valid-base64!!!'
      });
      expect(hasOciEnvCredentials()).toBe(true);
    });

    it('false when all envs empty', () => {
      expect(hasOciEnvCredentials()).toBe(false);
    });
  });

  describe('createOciAuthProvider', () => {
    it('creates SimpleAuthenticationDetailsProvider with credentials and region', () => {
      const oci = {
        region: 'eu-frankfurt-1',
        credentials: {
          tenancyId: 'ocid1.tenancy.1',
          userId: 'ocid1.user.1',
          fingerprint: 'fp',
          privateKey: PEM
        }
      } as never;
      const provider = createOciAuthProvider(oci);
      expect(mockOciProviderCtor).toHaveBeenCalledWith(
        'ocid1.tenancy.1',
        'ocid1.user.1',
        'fp',
        PEM,
        null,
        { regionId: 'eu-frankfurt-1' }
      );
      expect(mockOciRegionFromId).toHaveBeenCalledWith('eu-frankfurt-1');
      expect(provider).toBeDefined();
    });

    it('throws when credentials incomplete', () => {
      const oci = { region: 'eu-frankfurt-1', credentials: { tenancyId: 't' } } as never;
      expect(() => createOciAuthProvider(oci)).toThrow(/OCI credentials missing/);
    });

    it('throws when no credentials object', () => {
      const oci = { region: 'eu-frankfurt-1' } as never;
      expect(() => createOciAuthProvider(oci)).toThrow(/OCI credentials missing/);
    });
  });
});
