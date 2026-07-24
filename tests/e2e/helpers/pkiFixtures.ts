/** Minimal PEM CSR shape accepted by provisioningRoutes before caService.signCSR. */
export const SAMPLE_CSR_PEM =
  '-----BEGIN CERTIFICATE REQUEST-----\nMIIBdummyCSR\n-----END CERTIFICATE REQUEST-----';

export const SAMPLE_CERT_ID = '507f1f77bcf86cd799439099';

export function sampleCertificateDoc() {
  return {
    _id: { toString: () => SAMPLE_CERT_ID },
    certificate: '-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----',
    expires_at: new Date('2030-06-01T00:00:00.000Z'),
    fingerprint: 'e2efingerprint'
  };
}
