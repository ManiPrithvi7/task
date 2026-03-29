import * as tls from 'tls';

/**
 * Node replaces the default CA store when `ca` is set. EMQX Cloud (DigiCert) chains
 * can include cross-signed intermediates that verify with the system store but fail
 * with a single PEM (e.g. only Global Root G2) → "unable to get local issuer certificate".
 * Merge Mozilla roots (same as Node default) with the explicit broker CA PEM.
 */
export function caForBrokerTls(customCaPem: string): string[] {
  return [...tls.rootCertificates, customCaPem];
}
