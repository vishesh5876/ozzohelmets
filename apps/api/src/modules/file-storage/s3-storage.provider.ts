import type { FileStorageProvider, StoredFile } from './file-storage.types';

/**
 * Placeholder for production object storage (S3 / compatible). Implement with
 * @aws-sdk/client-s3 using a private bucket, SSE-KMS, and no public ACLs; files are always
 * served through the API so visibility rules apply. Fails loudly until implemented.
 */
export class S3StorageProvider implements FileStorageProvider {
  readonly name = 's3';

  put(): Promise<void> {
    return Promise.reject(new Error('S3 storage provider is not implemented yet'));
  }

  get(): Promise<StoredFile | null> {
    return Promise.reject(new Error('S3 storage provider is not implemented yet'));
  }

  delete(): Promise<void> {
    return Promise.reject(new Error('S3 storage provider is not implemented yet'));
  }
}
