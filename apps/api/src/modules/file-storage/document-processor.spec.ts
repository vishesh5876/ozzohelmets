import sharp from 'sharp';
import { processProofOfPurchase } from './document-processor';

const MAX = 10 * 1024 * 1024;

describe('proof-of-purchase processing', () => {
  it('accepts a clean PDF as-is and re-encodes images to WebP', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n', 'latin1');
    expect(await processProofOfPurchase(pdf, MAX)).toMatchObject({
      contentType: 'application/pdf',
      extension: 'pdf',
    });
    const png = await sharp({
      create: { width: 200, height: 200, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const out = await processProofOfPurchase(png, MAX);
    expect(out.contentType).toBe('image/webp');
    expect(out.data.toString('ascii', 8, 12)).toBe('WEBP');
  });

  it('rejects by content, not by name: scripts, active PDFs, truncated PDFs, oversize', async () => {
    await expect(
      processProofOfPurchase(Buffer.from('<svg onload=alert(1)>'), MAX),
    ).rejects.toThrow();
    await expect(
      processProofOfPurchase(
        Buffer.from('%PDF-1.4\n/OpenAction << /S /JavaScript >>\n%%EOF', 'latin1'),
        MAX,
      ),
    ).rejects.toThrow(/scripts/);
    await expect(
      processProofOfPurchase(Buffer.from('%PDF-1.4\nno end', 'latin1'), MAX),
    ).rejects.toThrow(/incomplete/);
    await expect(processProofOfPurchase(Buffer.alloc(2000, 1), 1000)).rejects.toThrow(/smaller/);
    await expect(processProofOfPurchase(Buffer.alloc(0), MAX)).rejects.toThrow(/empty/);
  });
});
