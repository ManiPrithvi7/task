export interface ObjectHeadResult {
  sizeBytes: number;
  firmwareVersion?: string;
  sha256?: string;
}

export interface IFirmwareStorage {
  headObject(objectKey: string): Promise<ObjectHeadResult>;
  getObjectStream(objectKey: string): Promise<NodeJS.ReadableStream>;
  createPresignedPutUrl(objectKey: string, version: string): Promise<string>;
  createPresignedGetUrl(objectKey: string, version: string): Promise<string>;
  verifySha256(objectKey: string, sha256Hex: string): Promise<boolean>;
  buildObjectKey(version: string): string;
}
