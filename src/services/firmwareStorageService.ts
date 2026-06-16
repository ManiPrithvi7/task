/**
 * Oracle Cloud Object Storage firmware artifacts — PAR URLs and object metadata.
 */

import * as crypto from 'crypto';
import { Readable } from 'stream';
import { objectstorage } from 'oci-sdk';
import type { OtaConfig } from '../config';
import { otaOciParBaseUrl } from '../config/otaDefaults';
import { logger } from '../utils/logger';
import { createOciAuthProvider } from './ociAuthProvider';
import { mapOciError, withOciRetry } from './ociStorageErrors';

export const FIRMWARE_VERSION_METADATA_KEY = 'firmware-version';
export const FIRMWARE_SHA256_METADATA_KEY = 'sha256';

export interface ObjectHeadResult {
  sizeBytes: number;
  firmwareVersion?: string;
  sha256?: string;
}

export interface IFirmwareStorage {
  buildObjectKey(version: string): string;
  createPresignedPutUrl(objectKey: string, version: string): Promise<string>;
  createPresignedGetUrl(objectKey: string, firmwareVersion?: string): Promise<string>;
  headObject(objectKey: string): Promise<ObjectHeadResult>;
  verifySha256(objectKey: string, expectedSha256: string): Promise<boolean>;
  getObjectStream(objectKey: string): Promise<Readable>;
  verifyBucketAccess(): Promise<void>;
}

function metaValue(head: objectstorage.responses.HeadObjectResponse, key: string): string | undefined {
  const meta = head.opcMeta || {};
  const direct = meta[key];
  if (direct) return direct;

  const prefixed = `opc-meta-${key}`;
  if (meta[prefixed]) return meta[prefixed];

  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(meta)) {
    const normalized = k.toLowerCase().replace(/^opc-meta-/, '');
    if (normalized === lower) return v;
  }
  return undefined;
}

export class OciFirmwareStorageService implements IFirmwareStorage {
  private client: objectstorage.ObjectStorageClient;
  private config: OtaConfig;

  constructor(config: OtaConfig) {
    this.config = config;
    const oci = config.oci;
    const provider = createOciAuthProvider(oci);

    this.client = new objectstorage.ObjectStorageClient({
      authenticationDetailsProvider: provider
    });
    this.client.regionId = oci.region;
  }

  private parBaseUrl(): string {
    const override = this.config.oci.parBaseUrl?.replace(/\/+$/, '');
    if (override) return override;
    return otaOciParBaseUrl(this.config.oci.namespace, this.config.oci.region);
  }

  private buildParUrl(par: objectstorage.models.PreauthenticatedRequest): string {
    if (par.fullPath) {
      if (par.fullPath.startsWith('http://') || par.fullPath.startsWith('https://')) {
        return par.fullPath;
      }
      return `${this.parBaseUrl()}${par.fullPath.startsWith('/') ? '' : '/'}${par.fullPath}`;
    }
    const uri = par.accessUri.startsWith('/') ? par.accessUri : `/${par.accessUri}`;
    return `${this.parBaseUrl()}${uri}`;
  }

  buildObjectKey(version: string): string {
    const safe = version.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `firmware/${safe}/firmware.bin`;
  }

  /** @deprecated Use buildObjectKey */
  buildS3Key(version: string): string {
    return this.buildObjectKey(version);
  }

  async createPresignedPutUrl(objectKey: string, version: string): Promise<string> {
    return withOciRetry(async () => {
      try {
        const expires = new Date(Date.now() + this.config.presignedUrlTtlSec * 1000);
        const response = await this.client.createPreauthenticatedRequest({
          namespaceName: this.config.oci.namespace,
          bucketName: this.config.oci.bucket,
          createPreauthenticatedRequestDetails: {
            name: `ota-upload-${version}-${Date.now()}`.slice(0, 200),
            objectName: objectKey,
            accessType: objectstorage.models.CreatePreauthenticatedRequestDetails.AccessType.ObjectWrite,
            timeExpires: expires
          }
        });
        const url = this.buildParUrl(response.preauthenticatedRequest);
        logger.debug('[OTA] OCI upload PAR created', { objectKey, version });
        return url;
      } catch (err) {
        throw mapOciError(err);
      }
    });
  }

  async createPresignedGetUrl(objectKey: string, _firmwareVersion?: string): Promise<string> {
    return withOciRetry(async () => {
      try {
        const expires = new Date(Date.now() + this.config.presignedUrlTtlSec * 1000);
        const response = await this.client.createPreauthenticatedRequest({
          namespaceName: this.config.oci.namespace,
          bucketName: this.config.oci.bucket,
          createPreauthenticatedRequestDetails: {
            name: `ota-download-${Date.now()}`.slice(0, 200),
            objectName: objectKey,
            accessType: objectstorage.models.CreatePreauthenticatedRequestDetails.AccessType.ObjectRead,
            timeExpires: expires
          }
        });
        return this.buildParUrl(response.preauthenticatedRequest);
      } catch (err) {
        throw mapOciError(err);
      }
    });
  }

  async headObject(objectKey: string): Promise<ObjectHeadResult> {
    return withOciRetry(async () => {
      try {
        const head = await this.client.headObject({
          namespaceName: this.config.oci.namespace,
          bucketName: this.config.oci.bucket,
          objectName: objectKey
        });
        return {
          sizeBytes: head.contentLength ?? 0,
          firmwareVersion: metaValue(head, FIRMWARE_VERSION_METADATA_KEY),
          sha256: metaValue(head, FIRMWARE_SHA256_METADATA_KEY)
        };
      } catch (err) {
        throw mapOciError(err);
      }
    });
  }

  async verifySha256(objectKey: string, expectedSha256: string): Promise<boolean> {
    const stream = await this.getObjectStream(objectKey);
    const hash = crypto.createHash('sha256');
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex').toLowerCase() === expectedSha256.toLowerCase();
  }

  async getObjectStream(objectKey: string): Promise<Readable> {
    return withOciRetry(async () => {
      try {
        const res = await this.client.getObject({
          namespaceName: this.config.oci.namespace,
          bucketName: this.config.oci.bucket,
          objectName: objectKey
        });
        if (!res.value) {
          throw new Error('Empty OCI object body');
        }
        return res.value as Readable;
      } catch (err) {
        throw mapOciError(err);
      }
    });
  }

  async verifyBucketAccess(): Promise<void> {
    await withOciRetry(async () => {
      try {
        await this.client.headBucket({
          namespaceName: this.config.oci.namespace,
          bucketName: this.config.oci.bucket
        });
        logger.info('[OTA] OCI bucket access verified', {
          bucket: this.config.oci.bucket,
          namespace: this.config.oci.namespace,
          region: this.config.oci.region
        });
      } catch (err) {
        throw mapOciError(err);
      }
    });
  }
}

export function createFirmwareStorageService(config: OtaConfig): IFirmwareStorage {
  return new OciFirmwareStorageService(config);
}

/** @deprecated Use IFirmwareStorage */
export type FirmwareStorageService = IFirmwareStorage;
