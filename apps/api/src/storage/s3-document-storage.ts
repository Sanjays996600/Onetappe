import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  MAX_DOCUMENT_BYTES,
  UPLOAD_TTL_SECONDS,
  type DocumentStorage,
  type ObjectInfo,
  type UploadTarget,
} from './document-storage.js';

export interface S3StorageConfig {
  readonly bucket: string;
  readonly region: string;
  /** Only for S3-compatible test servers (MinIO, moto); unset for AWS. */
  readonly endpoint?: string;
  /** Customer-managed KMS key for server-side encryption (recommended in production). */
  readonly kmsKeyId?: string;
}

/**
 * Amazon S3 (company-owned private bucket, Block Public Access on). Uploads use a
 * presigned POST whose policy enforces the object key, content type, size range and
 * encryption, and expires in five minutes. Objects are never public and are read only by
 * the API with its IAM role. Credentials come from the runtime role, never from code.
 */
export class S3DocumentStorage implements DocumentStorage {
  readonly name = 's3';
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    });
  }

  async createUploadTarget(
    key: string,
    contentType: string,
    maxBytes: number,
  ): Promise<UploadTarget> {
    const encryption: Record<string, string> = this.config.kmsKeyId
      ? {
          'x-amz-server-side-encryption': 'aws:kms',
          'x-amz-server-side-encryption-aws-kms-key-id': this.config.kmsKeyId,
        }
      : { 'x-amz-server-side-encryption': 'AES256' };
    const post = await createPresignedPost(this.client, {
      Bucket: this.config.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', contentType],
        ...Object.entries(encryption).map(([field, value]) => ['eq', `$${field}`, value]),
      ] as never,
      Fields: { 'Content-Type': contentType, ...encryption },
      Expires: UPLOAD_TTL_SECONDS,
    });
    return {
      method: 'POST',
      url: post.url,
      headers: {},
      fields: post.fields,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
      maxBytes,
    };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return { size: result.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async read(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if ((result.ContentLength ?? 0) > MAX_DOCUMENT_BYTES) {
      throw new Error(`Object ${key} exceeds the document size limit`);
    }
    const body = await result.Body?.transformToByteArray();
    if (!body) throw new Error(`Object ${key} has no body`);
    return Buffer.from(body);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof NotFound ||
    (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
  );
}
