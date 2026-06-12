/**
 * S3 firmware artifact storage — presigned URLs and object metadata.
 */

import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { logger } from '../utils/logger';
import type { OtaConfig } from '../config';

export const FIRMWARE_VERSION_METADATA_KEY = 'firmware-version';
export const FIRMWARE_SHA256_METADATA_KEY = 'sha256';

export class FirmwareStorageService {
  private client: S3Client;
  private config: OtaConfig;

  constructor(config: OtaConfig) {
    this.config = config;
    const credentials =
      config.s3.accessKeyId && config.s3.secretAccessKey
        ? {
            accessKeyId: config.s3.accessKeyId,
            secretAccessKey: config.s3.secretAccessKey
          }
        : undefined;

    this.client = new S3Client({
      region: config.s3.region,
      ...(credentials ? { credentials } : {})
    });
  }

  buildS3Key(version: string): string {
    const safe = version.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `firmware/${safe}/firmware.bin`;
  }

  async createPresignedPutUrl(s3Key: string, version: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.config.s3.bucket,
      Key: s3Key,
      ContentType: 'application/octet-stream',
      Metadata: {
        [FIRMWARE_VERSION_METADATA_KEY]: version
      }
    });
    return getSignedUrl(this.client, command, { expiresIn: this.config.presignedUrlTtlSec });
  }

  async createPresignedGetUrl(s3Key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.s3.bucket,
      Key: s3Key
    });
    return getSignedUrl(this.client, command, { expiresIn: this.config.presignedUrlTtlSec });
  }

  async headObject(s3Key: string): Promise<{
    sizeBytes: number;
    firmwareVersion?: string;
    sha256?: string;
  }> {
    const res = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: s3Key
      })
    );
    const meta = res.Metadata || {};
    return {
      sizeBytes: res.ContentLength ?? 0,
      firmwareVersion: meta[FIRMWARE_VERSION_METADATA_KEY],
      sha256: meta[FIRMWARE_SHA256_METADATA_KEY]
    };
  }

  async verifySha256(s3Key: string, expectedSha256: string): Promise<boolean> {
    const stream = await this.getObjectStream(s3Key);
    const hash = crypto.createHash('sha256');
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    const digest = hash.digest('hex');
    return digest.toLowerCase() === expectedSha256.toLowerCase();
  }

  async ensureFirmwareMetadata(s3Key: string, version: string, sha256: string): Promise<void> {
    const head = await this.headObject(s3Key);
    if (head.firmwareVersion === version && head.sha256 === sha256) {
      return;
    }

    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: s3Key,
        CopySource: `${this.config.s3.bucket}/${s3Key}`,
        MetadataDirective: 'REPLACE',
        Metadata: {
          [FIRMWARE_VERSION_METADATA_KEY]: version,
          [FIRMWARE_SHA256_METADATA_KEY]: sha256
        },
        ContentType: 'application/octet-stream'
      })
    );

    logger.info('[OTA] S3 object metadata backfilled', { s3Key, version });
  }

  async getObjectStream(s3Key: string): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: s3Key
      })
    );
    if (!res.Body) {
      throw new Error('Empty S3 object body');
    }
    return res.Body as Readable;
  }
}
