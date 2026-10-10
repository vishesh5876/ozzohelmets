import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { type FileStorageProvider, STORAGE_KEY_REGEX, type StoredFile } from './file-storage.types';

/**
 * Local-filesystem provider (single VPS; the root is a persistent bind mount, never the container
 * layer). Defence in depth around server-generated keys:
 * - keys must match STORAGE_KEY_REGEX (`<prefix>/<uuid>.<ext>`) — no user-supplied names, no
 *   `..`, absolute paths or NUL bytes can reach the filesystem;
 * - the resolved path must stay under the root, and the real (symlink-resolved) parent directory
 *   must stay under the real root — a planted symlink directory can't redirect writes;
 * - files are opened with O_NOFOLLOW, written to an exclusive temp file and renamed into place
 *   (atomic; never follows or overwrites through a symlink);
 * - directories 0700, files 0600, owned by the container's non-root user.
 */
export class LocalStorageProvider implements FileStorageProvider {
  readonly name = 'local';
  private readonly root: string;
  private realRoot: string | null = null;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  /** Creates the root if needed and proves it is writable (called at startup). */
  async ensureReady(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const probe = join(this.root, `.write-probe-${process.pid}-${randomBytes(4).toString('hex')}`);
    await fs.writeFile(probe, 'ok', { mode: 0o600, flag: 'wx' });
    await fs.rm(probe, { force: true });
    this.realRoot = await fs.realpath(this.root);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const path = this.pathFor(key);
    const dir = dirname(path);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.assertInsideRoot(dir);
    await this.atomicWrite(`${path}.meta`, Buffer.from(JSON.stringify({ contentType })));
    await this.atomicWrite(path, data);
  }

  async get(key: string): Promise<StoredFile | null> {
    const path = this.pathFor(key);
    try {
      await this.assertInsideRoot(dirname(path));
      const [buffer, meta] = await Promise.all([
        this.readNoFollow(path),
        this.readNoFollow(`${path}.meta`),
      ]);
      return {
        buffer,
        contentType: (JSON.parse(meta.toString('utf8')) as { contentType: string }).contentType,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    // unlink removes a symlink itself, never its target.
    await Promise.all([fs.rm(path, { force: true }), fs.rm(`${path}.meta`, { force: true })]);
  }

  private pathFor(key: string): string {
    if (!STORAGE_KEY_REGEX.test(key)) throw new Error('Invalid storage key');
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return path;
  }

  private async assertInsideRoot(dir: string): Promise<void> {
    this.realRoot ??= await fs.realpath(this.root);
    const realDir = await fs.realpath(dir);
    if (realDir !== this.realRoot && !realDir.startsWith(this.realRoot + sep))
      throw new Error('Storage path escapes the storage root');
  }

  private async atomicWrite(path: string, data: Buffer): Promise<void> {
    const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    const handle = await fs.open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, path);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  private async readNoFollow(path: string): Promise<Buffer> {
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
}
