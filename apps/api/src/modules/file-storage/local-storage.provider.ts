import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type FileStorageProvider, STORAGE_KEY_REGEX, type StoredFile } from './file-storage.types';

/** Local-disk provider for development and single-node deployments. */
export class LocalStorageProvider implements FileStorageProvider {
  readonly name = 'local';
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, data, { mode: 0o600 });
    await fs.writeFile(`${path}.meta`, JSON.stringify({ contentType }), { mode: 0o600 });
  }

  async get(key: string): Promise<StoredFile | null> {
    const path = this.pathFor(key);
    try {
      const [buffer, meta] = await Promise.all([
        fs.readFile(path),
        fs.readFile(`${path}.meta`, 'utf8'),
      ]);
      return { buffer, contentType: (JSON.parse(meta) as { contentType: string }).contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await Promise.all([fs.rm(path, { force: true }), fs.rm(`${path}.meta`, { force: true })]);
  }

  private pathFor(key: string): string {
    if (!STORAGE_KEY_REGEX.test(key)) throw new Error('Invalid storage key');
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + '/')) throw new Error('Invalid storage key');
    return path;
  }
}
