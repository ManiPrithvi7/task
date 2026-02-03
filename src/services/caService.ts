/**
 * Certificate Authority Service (Lite)
 * Handles Root CA generation and CSR signing
 * Uses SQLite CertificateStore instead of MongoDB
 */

import * as fs from 'fs';
import * as path from 'path';
import * as forge from 'node-forge';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { DeviceCertificate, IDeviceCertificate, DeviceCertificateStatus } from '../models/DeviceCertificate';

/**
 * Thrown when the CSR uses a key type not supported by the current CA implementation.
 * node-forge only supports RSA; ECDSA/EC CSRs (e.g. from ESP32 with EC key) trigger this.
 * Client should retry with an RSA 2048-bit key and CSR (do not revoke token).
 */
export class UnsupportedCSRKeyTypeError extends Error {
  constructor(message: string = 'CSR uses a key type that is not supported (only RSA is supported). Please generate an RSA 2048-bit key and CSR on the device.') {
    super(message);
    this.name = 'UnsupportedCSRKeyTypeError';
    Object.setPrototypeOf(this, UnsupportedCSRKeyTypeError.prototype);
  }
}

export interface CAConfig {
  storagePath: string;
  rootCAValidityYears: number;
  deviceCertValidityDays: number;
}

export interface RootCA {
  certificate: string;
  privateKey: string;
  serialNumber: string;
}

export class CAService {
  private config: CAConfig;
  private rootCA: RootCA | null = null;
  private readonly ROOT_CA_CERT_FILE = 'root-ca.crt';
  private readonly ROOT_CA_KEY_FILE = 'root-ca.key';

  constructor(config: CAConfig, _dbPath?: string) {
    this.config = config;
    // Always use MongoDB - parameters kept for backward compatibility
  }

  /**
   * Initialize Root CA
   */
  async initialize(): Promise<void> {
    try {
      const certPath = path.join(this.config.storagePath, this.ROOT_CA_CERT_FILE);
      const keyPath = path.join(this.config.storagePath, this.ROOT_CA_KEY_FILE);

      // Create storage directory
      await fs.promises.mkdir(this.config.storagePath, { recursive: true });

      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        logger.info('Loading existing Root CA');
        const certificate = await fs.promises.readFile(certPath, 'utf8');
        const privateKey = await fs.promises.readFile(keyPath, 'utf8');

        const cert = forge.pki.certificateFromPem(certificate);
        this.rootCA = {
          certificate,
          privateKey,
          serialNumber: cert.serialNumber
        };

        logger.info('Root CA loaded successfully', { serialNumber: cert.serialNumber });
      } else {
        logger.info('Generating new Root CA');
        await this.generateRootCA();
        logger.info('Root CA generated successfully');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to initialize Root CA', { error: errorMessage });
      throw new Error(`Root CA initialization failed: ${errorMessage}`);
    }
  }

  /**
   * Generate Root CA
   */
  private async generateRootCA(): Promise<void> {
    try {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();

      cert.publicKey = keys.publicKey;
      cert.serialNumber = this.generateSerialNumber();

      const notBefore = new Date();
      const notAfter = new Date();
      notAfter.setFullYear(notAfter.getFullYear() + this.config.rootCAValidityYears);

      cert.validity.notBefore = notBefore;
      cert.validity.notAfter = notAfter;

      cert.setSubject([
        { name: 'countryName', value: 'US' },
        { name: 'organizationName', value: 'StatsMQTT Lite' },
        { name: 'organizationalUnitName', value: 'Certificate Authority' },
        { name: 'commonName', value: 'StatsMQTT Lite Root CA' }
      ]);

      cert.setIssuer(cert.subject.attributes);

      cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier', subjectKeyIdentifier: true },
        { name: 'authorityKeyIdentifier', authorityKeyIdentifier: true }
      ]);

      cert.sign(keys.privateKey, forge.md.sha256.create());

      const certificatePem = forge.pki.certificateToPem(cert);
      const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

      // Store on filesystem
      const certPath = path.join(this.config.storagePath, this.ROOT_CA_CERT_FILE);
      const keyPath = path.join(this.config.storagePath, this.ROOT_CA_KEY_FILE);

      await fs.promises.writeFile(certPath, certificatePem);
      await fs.promises.writeFile(keyPath, privateKeyPem);
      await fs.promises.chmod(certPath, 0o644);
      await fs.promises.chmod(keyPath, 0o600);

      this.rootCA = {
        certificate: certificatePem,
        privateKey: privateKeyPem,
        serialNumber: cert.serialNumber
      };

      logger.info('Root CA generated', {
        serialNumber: cert.serialNumber,
        validFrom: notBefore.toISOString(),
        validTo: notAfter.toISOString()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to generate Root CA', { error: errorMessage });
      throw new Error(`Root CA generation failed: ${errorMessage}`);
    }
  }

  /**
   * Sign a CSR and create device certificate
   * Supports both SQLite and MongoDB storage
   */
  async signCSR(
    csrPem: string,
    deviceId: string,
    userId: string
  ): Promise<IDeviceCertificate> {
    try {
      if (!this.rootCA) {
        throw new Error('Root CA not initialized');
      }

      // Parse CSR (node-forge only supports RSA; EC/ECDSA CSRs throw "OID is not RSA")
      let csr: forge.pki.CertificateSigningRequest;
      try {
        csr = forge.pki.certificationRequestFromPem(csrPem);
      } catch (parseError) {
        const msg = parseError instanceof Error ? parseError.message : String(parseError);
        if (msg.includes('OID is not RSA') || msg.includes('not RSA')) {
          throw new UnsupportedCSRKeyTypeError(
            'CSR uses a non-RSA key (e.g. ECDSA/EC). Only RSA 2048-bit CSRs are supported. Please generate an RSA key pair and CSR on the device.'
          );
        }
        throw parseError;
      }

      // Verify CSR signature
      if (!csr.verify()) {
        throw new Error('Invalid CSR signature');
      }

      // Validate device_id in CSR
      const deviceIdValid = this.validateDeviceIdInCSR(csr, deviceId);
      if (!deviceIdValid) {
        throw new Error(`Device ID ${deviceId} not found in CSR`);
      }

      // Create certificate
      const cert = forge.pki.createCertificate();
      if (!csr.publicKey) {
        throw new Error('CSR does not contain a public key');
      }
      cert.publicKey = csr.publicKey;
      cert.serialNumber = this.generateSerialNumber();

      const notBefore = new Date();
      const notAfter = new Date();
      notAfter.setDate(notAfter.getDate() + this.config.deviceCertValidityDays);

      cert.validity.notBefore = notBefore;
      cert.validity.notAfter = notAfter;

      cert.setSubject(csr.subject.attributes);

      const rootCert = forge.pki.certificateFromPem(this.rootCA.certificate);
      cert.setIssuer(rootCert.subject.attributes);

      cert.setExtensions([
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: false, clientAuth: true, critical: true },
        { name: 'subjectKeyIdentifier', subjectKeyIdentifier: true },
        { name: 'authorityKeyIdentifier', authorityKeyIdentifier: true, authorityCertIssuer: true, serialNumber: this.rootCA.serialNumber }
      ]);

      // Copy SAN from CSR if present
      const sanExtension = csr.getAttribute({ name: 'extensionRequest' });
      if (sanExtension && (sanExtension as any).extensions) {
        const extensions = (sanExtension as any).extensions;
        const sanExt = extensions.find((ext: any) => ext.name === 'subjectAltName');
        if (sanExt) {
          cert.setExtensions([...cert.extensions, sanExt]);
        }
      }

      // Sign certificate
      const rootCAKey = forge.pki.privateKeyFromPem(this.rootCA.privateKey);
      cert.sign(rootCAKey, forge.md.sha256.create());

      const certificatePem = forge.pki.certificateToPem(cert);
      const cn = this.extractCNFromSubject(cert.subject);
      if (!cn) {
        throw new Error('Could not extract Common Name');
      }

      const fingerprint = this.generateCertificateFingerprint(certificatePem);

      // Store certificate in MongoDB
      // Note: private_key is required in schema but we use empty string
      // because device keeps its private key during CSR signing
      const certDoc = new DeviceCertificate({
        device_id: deviceId,
        user_id: new mongoose.Types.ObjectId(userId),
        certificate: certificatePem,
        private_key: '', // Empty string (device keeps its private key)
        ca_certificate: this.rootCA.certificate,
        cn,
        fingerprint,
        status: DeviceCertificateStatus.active,
        expires_at: notAfter,
        created_at: notBefore
      });

      await certDoc.save();

      logger.info('CSR signed and certificate stored in MongoDB', {
        deviceId,
        userId,
        cn,
        serialNumber: cert.serialNumber,
        expiresAt: notAfter.toISOString()
      });

      return certDoc;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to sign CSR', { deviceId, error: errorMessage });
      throw error;
    }
  }

  /**
   * Validate device_id in CSR
   */
  private validateDeviceIdInCSR(csr: any, deviceId: string): boolean {
    const cn = this.extractCNFromSubject(csr.subject);
    if (cn && cn.includes(deviceId)) {
      return true;
    }

    const extensionRequest = csr.getAttribute({ name: 'extensionRequest' });
    if (extensionRequest && (extensionRequest as any).extensions) {
      const extensions = (extensionRequest as any).extensions;
      const sanExt = extensions.find((ext: any) => ext.name === 'subjectAltName');
      if (sanExt) {
        const altNames = sanExt.altNames || [];
        for (const altName of altNames) {
          if (altName.value && altName.value.includes(deviceId)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Extract Common Name from subject
   */
  private extractCNFromSubject(subject: any): string | null {
    const cnAttr = subject.getField('CN');
    return cnAttr ? cnAttr.value : null;
  }

  /**
   * Generate certificate serial number
   */
  private generateSerialNumber(): string {
    const bytes = forge.random.getBytesSync(16);
    return forge.util.bytesToHex(bytes);
  }

  /**
   * Generate certificate fingerprint
   */
  private generateCertificateFingerprint(certificatePem: string): string {
    const cert = forge.pki.certificateFromPem(certificatePem);
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const md = forge.md.sha256.create();
    md.update(der);
    return md.digest().toHex();
  }

  /**
   * Get Root CA certificate
   */
  getRootCACertificate(): string {
    if (!this.rootCA) {
      throw new Error('Root CA not initialized');
    }
    return this.rootCA.certificate;
  }

  /**
   * Check if Root CA is initialized
   */
  isInitialized(): boolean {
    return this.rootCA !== null;
  }

  /**
   * Find active certificate by device ID
   */
  async findActiveCertificateByDeviceId(deviceId: string): Promise<IDeviceCertificate | null> {
    try {
      const cert = await DeviceCertificate.findOne({
        device_id: deviceId,
        status: DeviceCertificateStatus.active
      });
      
      if (!cert) return null;
      
      // Check if expired
      const now = new Date();
      if (cert.expires_at < now) {
        return null;
      }
      
      return cert;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to find active certificate', { deviceId, error: errorMessage });
      return null;
    }
  }

  /**
   * Find certificate by ID
   */
  async findCertificateById(id: string): Promise<IDeviceCertificate | null> {
    try {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return null;
      }
      return await DeviceCertificate.findById(id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to find certificate by ID', { id, error: errorMessage });
      return null;
    }
  }

  /**
   * Find certificate by device ID
   */
  async findCertificateByDeviceId(deviceId: string): Promise<IDeviceCertificate | null> {
    try {
      return await DeviceCertificate.findOne({ device_id: deviceId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to find certificate by device ID', { deviceId, error: errorMessage });
      return null;
    }
  }

  /**
   * Update certificate status
   */
  async updateCertificateStatus(certIdOrDeviceId: string, status: DeviceCertificateStatus): Promise<void> {
    try {
      // Try as MongoDB _id first
      if (mongoose.Types.ObjectId.isValid(certIdOrDeviceId)) {
        const cert = await DeviceCertificate.findById(certIdOrDeviceId);
        if (cert) {
          cert.status = status;
          if (status === DeviceCertificateStatus.revoked) {
            cert.revoked_at = new Date();
          }
          await cert.save();
          logger.info('Certificate status updated', { 
            certificateId: certIdOrDeviceId, 
            status 
          });
          return;
        }
      }
      
      // Try as device_id
      const cert = await DeviceCertificate.findOne({ device_id: certIdOrDeviceId });
      if (cert) {
        cert.status = status;
        if (status === DeviceCertificateStatus.revoked) {
          cert.revoked_at = new Date();
        }
        await cert.save();
        logger.info('Certificate status updated', { 
          deviceId: certIdOrDeviceId, 
          status 
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to update certificate status', { 
        certIdOrDeviceId, 
        status, 
        error: errorMessage 
      });
      throw error;
    }
  }
}

