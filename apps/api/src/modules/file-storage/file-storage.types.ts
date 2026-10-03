export interface StoredFile {
  buffer: Buffer;
  contentType: string;
}

/** Storage port. Keys are generated server-side (never from user input). */
export interface FileStorageProvider {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}

export const FILE_STORAGE_PROVIDER = Symbol('FILE_STORAGE_PROVIDER');

/** `profile-photos/<uuid>.webp` style keys only — rejects traversal and odd characters. */
export const STORAGE_KEY_REGEX = /^[a-z0-9-]+\/[0-9a-f-]{36}\.(webp|jpg|png)$/;
