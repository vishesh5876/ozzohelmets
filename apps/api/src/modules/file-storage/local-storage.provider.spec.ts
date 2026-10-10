import { mkdtempSync, promises as fs, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageProvider } from './local-storage.provider';

const uuid = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';

describe('LocalStorageProvider (filesystem safety)', () => {
  let root: string;
  let outside: string;
  let storage: LocalStorageProvider;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'helmet-storage-'));
    outside = mkdtempSync(join(tmpdir(), 'helmet-outside-'));
    storage = new LocalStorageProvider(root);
    await storage.ensureReady();
  });

  it('round-trips a file with 0600 permissions and atomic writes (no temp files left)', async () => {
    await storage.put(`warranty-proofs/${uuid}.pdf`, Buffer.from('%PDF-1.4 x'), 'application/pdf');
    const got = await storage.get(`warranty-proofs/${uuid}.pdf`);
    expect(got?.contentType).toBe('application/pdf');
    expect(got?.buffer.toString()).toBe('%PDF-1.4 x');
    const stat = await fs.stat(join(root, `warranty-proofs/${uuid}.pdf`));
    expect(stat.mode & 0o777).toBe(0o600);
    const dirStat = await fs.stat(join(root, 'warranty-proofs'));
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect((await fs.readdir(join(root, 'warranty-proofs'))).some((f) => f.includes('.tmp-'))).toBe(
      false,
    );
    await storage.delete(`warranty-proofs/${uuid}.pdf`);
    expect(await storage.get(`warranty-proofs/${uuid}.pdf`)).toBeNull();
  });

  it.each([
    '../etc/passwd',
    `profile-photos/../../${uuid}.webp`,
    `/etc/${uuid}.webp`,
    `profile-photos/${uuid}.webp\0.png`,
    'profile-photos/evil name.webp',
    `profile-photos/${uuid}.exe`,
    `Profile-Photos/${uuid}.webp`,
  ])('rejects unsafe key %j', async (key) => {
    await expect(storage.put(key, Buffer.from('x'), 'image/webp')).rejects.toThrow(
      'Invalid storage key',
    );
    await expect(storage.get(key)).rejects.toThrow('Invalid storage key');
  });

  it('refuses to write or read through a symlinked directory that points outside the root', async () => {
    symlinkSync(outside, join(root, 'profile-photos'));
    await expect(
      storage.put(`profile-photos/${uuid}.webp`, Buffer.from('x'), 'image/webp'),
    ).rejects.toThrow(/escapes the storage root/);
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.writeFile(join(outside, `${uuid}.webp`), 'secret');
    await expect(storage.get(`profile-photos/${uuid}.webp`)).rejects.toThrow(
      /escapes the storage root/,
    );
  });

  it('never follows a symlinked file (read) or writes through it (rename replaces the link)', async () => {
    await fs.mkdir(join(root, 'profile-photos'), { mode: 0o700 });
    const target = join(outside, 'target');
    await fs.writeFile(target, 'outside');
    symlinkSync(target, join(root, `profile-photos/${uuid}.webp`));
    symlinkSync(target, join(root, `profile-photos/${uuid}.webp.meta`));
    await expect(storage.get(`profile-photos/${uuid}.webp`)).rejects.toMatchObject({
      code: 'ELOOP',
    });
    await storage.put(`profile-photos/${uuid}.webp`, Buffer.from('new'), 'image/webp');
    expect(await fs.readFile(target, 'utf8')).toBe('outside');
    expect((await storage.get(`profile-photos/${uuid}.webp`))?.buffer.toString()).toBe('new');
  });

  it('fails readiness when the root is not writable', async () => {
    if (process.getuid?.() === 0) return; // root ignores permission bits
    await fs.chmod(root, 0o500);
    await expect(new LocalStorageProvider(root).ensureReady()).rejects.toThrow();
  });
});
