/**
 * Decode CSR from PEM or base64-encoded PEM (shared by provisioning, lifecycle, recovery).
 */

export function decodeCsrToPem(raw: unknown): string {
  const csr = typeof raw === 'string' ? raw.trim() : raw != null ? String(raw).trim() : '';
  if (!csr) throw new Error('csr is required');

  if (csr.includes('-----BEGIN CERTIFICATE REQUEST-----')) {
    const pem = csr.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    if (!pem.includes('-----END CERTIFICATE REQUEST-----')) {
      throw new Error('csr PEM missing END CERTIFICATE REQUEST');
    }
    return pem;
  }

  const pem = Buffer.from(csr, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE REQUEST-----') || !pem.includes('-----END CERTIFICATE REQUEST-----')) {
    throw new Error('csr must be PEM or base64-encoded PEM CSR');
  }
  return pem;
}
