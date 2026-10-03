import sharp from 'sharp';
import { processProfilePhoto, sniffImage } from './image-processor';

const MAX = 5 * 1024 * 1024;
const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

describe('profile photo processing', () => {
  it('sniffs formats from magic bytes, not names', async () => {
    expect(sniffImage(await png(10, 10))).toBe('png');
    expect(
      sniffImage(
        await sharp(await png(10, 10))
          .jpeg()
          .toBuffer(),
      ),
    ).toBe('jpeg');
    expect(
      sniffImage(
        await sharp(await png(10, 10))
          .webp()
          .toBuffer(),
      ),
    ).toBe('webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull();
  });

  it('re-encodes to WebP, downsizes and strips metadata (incl. GPS)', async () => {
    const withExif = await sharp(await png(1600, 1200))
      .jpeg()
      .withMetadata({
        exif: { IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'N' } },
      })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const out = await processProfilePhoto(withExif, MAX);
    expect(out.contentType).toBe('image/webp');
    expect(Math.max(out.width, out.height)).toBe(800);
    const meta = await sharp(out.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(out.data.includes(Buffer.from('secret-owner'))).toBe(false);
  });

  it('rejects SVG, tiny, oversized, corrupt and empty files', async () => {
    await expect(
      processProfilePhoto(Buffer.from('<svg onload="alert(1)"/>'), MAX),
    ).rejects.toMatchObject({ code: 'INVALID_FILE' });
    await expect(processProfilePhoto(await png(20, 20), MAX)).rejects.toMatchObject({
      code: 'INVALID_FILE',
    });
    await expect(processProfilePhoto(await png(200, 200), 100)).rejects.toMatchObject({
      code: 'INVALID_FILE',
    });
    const truncated = (await png(300, 300)).subarray(0, 60);
    await expect(processProfilePhoto(truncated, MAX)).rejects.toMatchObject({
      code: 'INVALID_FILE',
    });
    await expect(processProfilePhoto(Buffer.alloc(0), MAX)).rejects.toMatchObject({
      code: 'INVALID_FILE',
    });
  });
});
