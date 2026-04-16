/**
 * Certificate Authority Service (Lite)
 * Handles Root CA generation and CSR signing
 * Uses SQLite CertificateStore instead of MongoDB
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as forge from 'node-forge';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import {
  DeviceCertificate,
  IDeviceCertificate,
  DeviceCertificateStatus,
  DeviceCertificateSlot
} from '../models/DeviceCertificate';

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

/**
 * Thrown when the device already has an active certificate and replace is not allowed.
 * Route should return 409 with code DEVICE_HAS_ACTIVE_CERTIFICATE.
 */
export class DeviceAlreadyHasCertificateError extends Error {
  public certificateId?: string;

  constructor(message: string = 'Device already has an active certificate', certificateId?: string) {
    super(message);
    this.name = 'DeviceAlreadyHasCertificateError';
    this.certificateId = certificateId;
    Object.setPrototypeOf(this, DeviceAlreadyHasCertificateError.prototype);
  }
}

export interface CAConfig {
  storagePath: string;
  rootCAValidityYears: number;
  deviceCertValidityDays: number;
  certProfile?: {
    validityDays?: number;
    keyUsage?: string[];
    extendedKeyUsage?: string[];
    requireSanDeviceId?: boolean;
    minKeyBits?: number;
  };
}

export interface RootCA {
  certificate: string;
  privateKey: string;
  serialNumber: string;
}

export class CAService {
  private config: CAConfig;
  private rootCA: RootCA | null = null;
  /** Loaded from config.storagePath (default `src/certs`; override `CA_STORAGE_PATH` in containers without a `src/` tree). */
  private readonly ROOT_CA_CERT_FILE = 'root-ca.crt';
  private readonly ROOT_CA_KEY_FILE = 'root-ca.key';

  constructor(config: CAConfig, _dbPath?: string) {
    this.config = config;
    // Always use MongoDB - parameters kept for backward compatibility
  }

  private normalizeSlot(slot: DeviceCertificateSlot | undefined): DeviceCertificateSlot {
    return slot === 'staging' ? 'staging' : 'primary';
  }

  /**
   * Format expected CN for a device.
   * Normalizes configured prefix and avoids double-prefixing when deviceId already includes the prefix.
   *
   * Examples:
   *  - prefix 'PROOF' + deviceId 'ADMIN-123' => 'PROOF-ADMIN-123'
   *  - prefix 'PROOF' + deviceId 'PROOF-ADMIN-123' => 'PROOF-ADMIN-123'
   */
  public formatExpectedCN(deviceId: string): string {
    const rawPrefix = process.env.CERT_CN_PREFIX || 'PROOF';
    // Normalize prefix: remove trailing separators like '-' or '_' and whitespace
    const prefix = String(rawPrefix).trim().replace(/[-_]+$/g, '');

    // If deviceId already starts with prefix (with optional separators), strip it
    const device = String(deviceId).replace(new RegExp(`^${prefix}[-_]*`), '');

    return `${prefix}-${device}`;
  }

  /**
   * Initialize Root CA.
   *
   * Reads `root-ca.crt` and `root-ca.key` under `storagePath` only (no `process.env` here).
   * At process startup, `loadConfig()` may have written those files from env first:
   * `MQTT_TLS_CA_BASE64` + `MQTT_TLS_CA_KEY_BASE64` (base64 PEM only), via `writeProvisioningRootCaFromEnv()` — see `src/config/index.ts`.
   * If either file is missing, a new Root CA is generated on disk.
   */
  async initialize(): Promise<void> {
    try {
      const certPath = path.join(this.config.storagePath, this.ROOT_CA_CERT_FILE);
      const keyPath = path.join(this.config.storagePath, this.ROOT_CA_KEY_FILE);

      // Create storage directory
      await fs.promises.mkdir(this.config.storagePath, { recursive: true });

      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        logger.info('Root CA: reading certificate and key from disk', { certPath, keyPath });
        const certificate = await fs.promises.readFile(certPath, 'utf8');
        const privateKey = await fs.promises.readFile(keyPath, 'utf8');

        const cert = forge.pki.certificateFromPem(certificate);
        this.rootCA = {
          certificate,
          privateKey,
          serialNumber: cert.serialNumber
        };

        const certShaPrefix = crypto.createHash('sha256').update(certificate, 'utf8').digest('hex').slice(0, 16);
        logger.info('Root CA loaded successfully', {
          serialNumber: cert.serialNumber,
          cert_pem_bytes: Buffer.byteLength(certificate, 'utf8'),
          key_pem_bytes: Buffer.byteLength(privateKey, 'utf8'),
          cert_sha256_prefix: certShaPrefix
        });
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
        { name: 'organizationName', value: 'Proof' },
        { name: 'organizationalUnitName', value: 'Certificate Authority' },
        { name: 'commonName', value: 'PROOF-CA' }
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
    userId: string,
    opts?: { slot?: DeviceCertificateSlot; allowReplacePrimary?: boolean }
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

      // Certificate profile from config or defaults
      const profile = this.config.certProfile || {};
      const minKeyBits = profile.minKeyBits || 2048;
      const validityDays = profile.validityDays || this.config.deviceCertValidityDays || 90;

      // Validate key strength (only RSA supported reliably by node-forge)
      try {
        const pub: any = csr.publicKey;
        if (!pub || !pub.n || typeof pub.n.bitLength !== 'function') {
          // Not RSA
          throw new UnsupportedCSRKeyTypeError(
            'CSR uses a non-RSA key (only RSA is supported in this CA implementation). Please generate an RSA 2048-bit key and CSR on the device.'
          );
        }
        const bits = pub.n.bitLength();
        if (bits < minKeyBits) {
          throw new Error(`RSA key too small (${bits} bits). Minimum required is ${minKeyBits} bits.`);
        }
      } catch (err) {
        if (err instanceof UnsupportedCSRKeyTypeError) throw err;
        // rethrow other errors
        if (err instanceof Error && err.message && err.message.includes('RSA')) {
          throw err;
        }
      }

      // Validate device_id and CN/SAN format against expected profile rules
      const deviceIdValid = this.validateDeviceIdInCSR(csr, deviceId);
      if (!deviceIdValid) {
        throw new Error(`CSR CN/SAN did not match expected format for device ${deviceId}`);
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
      notAfter.setDate(notAfter.getDate() + validityDays);

      cert.validity.notBefore = notBefore;
      cert.validity.notAfter = notAfter;

      cert.setSubject(csr.subject.attributes);

      const rootCert = forge.pki.certificateFromPem(this.rootCA.certificate);
      cert.setIssuer(rootCert.subject.attributes);

      // Build extensions based on profile
      const keyUsageFlags: any = {};
      const ku = profile.keyUsage || ['digitalSignature', 'keyEncipherment'];
      for (const usage of ku) {
        if (usage === 'digitalSignature') keyUsageFlags.digitalSignature = true;
        if (usage === 'keyEncipherment') keyUsageFlags.keyEncipherment = true;
        if (usage === 'keyCertSign') keyUsageFlags.keyCertSign = true;
        if (usage === 'cRLSign') keyUsageFlags.cRLSign = true;
      }

      const extKeyUsageFlags: any = {};
      const eku = profile.extendedKeyUsage || ['clientAuth'];
      for (const e of eku) {
        if (e === 'clientAuth') extKeyUsageFlags.clientAuth = true;
        if (e === 'serverAuth') extKeyUsageFlags.serverAuth = true;
        if (e === 'emailProtection') extKeyUsageFlags.emailProtection = true;
      }

      const extensions: any[] = [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', ...keyUsageFlags, critical: true },
        { name: 'extKeyUsage', ...extKeyUsageFlags, critical: true },
        { name: 'subjectKeyIdentifier', subjectKeyIdentifier: true },
        { name: 'authorityKeyIdentifier', authorityKeyIdentifier: true, authorityCertIssuer: true, serialNumber: this.rootCA.serialNumber }
      ];

      // Add SAN if required by profile or if CSR provided SAN (preserve existing SANs)
      const sanRequired = profile.requireSanDeviceId !== undefined ? profile.requireSanDeviceId : true;
      const expectedCN = this.extractCNFromSubject(csr.subject) || this.formatExpectedCN(deviceId);
      const sanExtension = csr.getAttribute({ name: 'extensionRequest' });
      if (sanExtension && (sanExtension as any).extensions) {
        // Reuse SAN from CSR if present
        const extensionsFromCSR = (sanExtension as any).extensions;
        const sanExt = extensionsFromCSR.find((ext: any) => ext.name === 'subjectAltName');
        if (sanExt) {
          extensions.push(sanExt);
        }
      } else if (sanRequired) {
        // Add SAN with expected CN as DNS alt name
        extensions.push({
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: expectedCN } // type 2 = DNS name
          ]
        });
      }

      cert.setExtensions(extensions);

      // Sign certificate
      const rootCAKey = forge.pki.privateKeyFromPem(this.rootCA.privateKey);
      cert.sign(rootCAKey, forge.md.sha256.create());

      const certificatePem = forge.pki.certificateToPem(cert);
      const cn = this.extractCNFromSubject(cert.subject);
      if (!cn) {
        throw new Error('Could not extract Common Name');
      }

      const fingerprint = this.generateCertificateFingerprint(certificatePem);

      // Audit helper: record certificate events to DB collection or append to audit log file
      const audit = async (event: string, details: any) => {
        try {
          const mongooseConnected = mongoose.connection && (mongoose.connection.readyState === 1);
          const entry = {
            event,
            deviceId,
            userId,
            details,
            timestamp: new Date()
          };
          if (mongooseConnected && mongoose.connection.db) {
            await mongoose.connection.db.collection('certificate_audit').insertOne(entry);
          } else {
            const logPath = path.join(this.config.storagePath, 'audit.log');
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
          }
        } catch (err: any) {
          logger.warn('Failed to write audit log', { error: err?.message ?? String(err) });
        }
      };
      
      const slot = this.normalizeSlot(opts?.slot);
      const allowReplacePrimaryDefault =
        process.env.ALLOW_ONBOARDING_WITH_ACTIVE_CERT === 'true' || process.env.NODE_ENV === 'development';
      const allowReplacePrimary = opts?.allowReplacePrimary ?? allowReplacePrimaryDefault;

      // If MongoDB is not connected, skip DB persistence and return a lightweight certificate object.
      const mongooseConnected = mongoose.connection && (mongoose.connection.readyState === 1);
      if (!mongooseConnected) {
        logger.warn('MongoDB not connected - skipping certificate persistence. Returning in-memory certificate object.', { deviceId });
        const mockDoc: any = {
          _id: new mongoose.Types.ObjectId(),
          device_id: deviceId,
          slot,
          user_id: new mongoose.Types.ObjectId(userId),
          certificate: certificatePem,
          private_key: '',
          ca_certificate: this.rootCA.certificate,
          cn,
          fingerprint,
          status: DeviceCertificateStatus.active,
          expires_at: notAfter,
          created_at: notBefore,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        logger.info('CSR signed (in-memory)', {
          deviceId,
          cn,
          serialNumber: cert.serialNumber,
          expiresAt: notAfter.toISOString()
        });
        await audit('CERT_ISSUED_IN_MEMORY', { serialNumber: cert.serialNumber, cn, expiresAt: notAfter.toISOString() });
        return mockDoc as IDeviceCertificate;
      }

      // Primary slot retains the historical “do not replace active primary unless allowed” behavior.
      if (slot === 'primary' && !allowReplacePrimary) {
        const existingActivePrimary = await this.findActiveCertificateByDeviceId(deviceId, { slots: ['primary'] });
        if (existingActivePrimary) {
          throw new DeviceAlreadyHasCertificateError(
            'Device already has an active certificate',
            existingActivePrimary._id.toString()
          );
        }
      }

      // Slot-scoped upsert: ensures at most one record per device_id+slot.
      // For staging renewal, this overwrites the staging slot without touching the primary.
      const certDoc = await DeviceCertificate.findOneAndUpdate(
        { device_id: deviceId, slot },
        {
          $set: {
            user_id: new mongoose.Types.ObjectId(userId),
            slot,
            certificate: certificatePem,
            private_key: '', // Empty string (device keeps its private key)
            ca_certificate: this.rootCA.certificate,
            cn,
            fingerprint,
            status: DeviceCertificateStatus.active,
            expires_at: notAfter,
            created_at: notBefore
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      await audit('CERT_ISSUED', { certificateId: certDoc._id, serialNumber: cert.serialNumber, cn, expiresAt: notAfter.toISOString() });

      logger.info('CSR signed and certificate stored in MongoDB', {
        deviceId,
        userId,
        slot,
        cn,
        serialNumber: cert.serialNumber,
        expiresAt: notAfter.toISOString()
      });

      return certDoc as IDeviceCertificate;
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
    const expectedCN = this.formatExpectedCN(deviceId);

    const cn = this.extractCNFromSubject(csr.subject);
    if (cn && cn === expectedCN) {
      return true;
    }

    const extensionRequest = csr.getAttribute({ name: 'extensionRequest' });
    if (extensionRequest && (extensionRequest as any).extensions) {
      const extensions = (extensionRequest as any).extensions;
      const sanExt = extensions.find((ext: any) => ext.name === 'subjectAltName');
      if (sanExt) {
        const altNames = sanExt.altNames || [];
        for (const altName of altNames) {
          if (altName.value && altName.value === expectedCN) {
            return true;
          }
        }
      }
    }

    logger.warn('CSR CN/SAN did not match expected format', { expectedCN, foundCN: cn });
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
   * Slot-aware active certificate lookup.
   * Defaults to primary-only for backward compatibility.
   */
  async findActiveCertificateByDeviceId(
    deviceId: string,
    opts?: { slots?: DeviceCertificateSlot[] }
  ): Promise<IDeviceCertificate | null> {
    try {
      const now = new Date();
      const slots = (opts?.slots?.length ? opts.slots : (['primary'] as DeviceCertificateSlot[])).map((s) =>
        this.normalizeSlot(s)
      );
      const cert = await DeviceCertificate.findOne({
        device_id: deviceId,
        status: DeviceCertificateStatus.active,
        slot: { $in: slots },
        expires_at: { $gt: now }
      }).sort({ slot: 1 }); // primary then staging if both are in query
      return cert || null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to find active certificate (slot-aware)', { deviceId, error: errorMessage });
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
  async findCertificateByDeviceId(deviceId: string, slot?: DeviceCertificateSlot): Promise<IDeviceCertificate | null> {
    try {
      const s = slot ? this.normalizeSlot(slot) : 'primary';
      return await DeviceCertificate.findOne({ device_id: deviceId, slot: s });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to find certificate by device ID', { deviceId, error: errorMessage });
      return null;
    }
  }

  async promoteStagingToPrimary(deviceId: string): Promise<{ promoted: boolean }> {
    const now = new Date();
    // Fetch both in parallel for clear error messaging
    const [staging, primary] = await Promise.all([
      DeviceCertificate.findOne({ device_id: deviceId, slot: 'staging', status: DeviceCertificateStatus.active }),
      DeviceCertificate.findOne({ device_id: deviceId, slot: 'primary', status: DeviceCertificateStatus.active })
    ]);
    if (!staging) {
      return { promoted: false };
    }

    // Revoke old primary (if any) only at confirm time.
    if (primary) {
      primary.status = DeviceCertificateStatus.revoked;
      primary.revoked_at = now;
      await primary.save();
    }

    // Promote staging → primary by changing slot.
    staging.slot = 'primary';
    await staging.save();

    // Ensure there is no remaining active staging (defense-in-depth)
    await DeviceCertificate.updateMany(
      { device_id: deviceId, slot: 'staging', status: DeviceCertificateStatus.active },
      { $set: { status: DeviceCertificateStatus.revoked, revoked_at: now } }
    );

    return { promoted: true };
  }

  async revokeAllDeviceCertificates(deviceId: string): Promise<number> {
    const now = new Date();
    const res = await DeviceCertificate.updateMany(
      { device_id: deviceId, status: DeviceCertificateStatus.active },
      { $set: { status: DeviceCertificateStatus.revoked, revoked_at: now } }
    );
    return (res as any).modifiedCount ?? 0;
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
      const now = new Date();
      const update: any = { status };
      if (status === DeviceCertificateStatus.revoked) {
        update.revoked_at = now;
      }

      // Slot model: when called with a device_id, apply to ALL slots for that device_id.
      const res = await DeviceCertificate.updateMany(
        { device_id: certIdOrDeviceId },
        { $set: update }
      );
      const modified = (res as any).modifiedCount ?? 0;
      if (modified > 0) {
        logger.info('Certificate status updated (all slots for device)', {
          deviceId: certIdOrDeviceId,
          status,
          modified
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

