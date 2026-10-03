/**
 * Development seed. Idempotent: safe to run repeatedly.
 * Credentials come from environment variables — never hard-code real credentials here.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { HashingService } from '../src/security/hashing.service';
import { BatchGenerationService } from '../src/modules/batches/batch-generation.service';

const SAMPLE_MODELS = [
  {
    name: 'Roadster X1',
    sku: 'RX1-MATTE-BLK',
    brand: 'Ozzo',
    description: 'Full-face touring helmet, matte black.',
  },
  {
    name: 'Roadster X1',
    sku: 'RX1-GLOSS-WHT',
    brand: 'Ozzo',
    description: 'Full-face touring helmet, gloss white.',
  },
  { name: 'Urban Jet', sku: 'UJ-OPEN-GRY', brand: 'Ozzo', description: 'Open-face city helmet.' },
];
const SEED_BATCH_NOTE = 'Seeded sample batch';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the seed`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Refusing to seed a production database');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const hashing = app.get(HashingService);
  const generator = app.get(BatchGenerationService);

  try {
    const email = requireEnv('SEED_SUPER_ADMIN_EMAIL').toLowerCase();
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    const admin =
      existing ??
      (await prisma.adminUser.create({
        data: {
          email,
          name: process.env.SEED_SUPER_ADMIN_NAME ?? 'Super Admin',
          passwordHash: await hashing.hashPassword(requireEnv('SEED_SUPER_ADMIN_PASSWORD')),
          role: 'SUPER_ADMIN',
        },
      }));
    console.log(`${existing ? '✓ exists ' : '✓ created'} SUPER_ADMIN ${email}`);

    for (const model of SAMPLE_MODELS) {
      await prisma.helmetModel.upsert({ where: { sku: model.sku }, update: {}, create: model });
    }
    console.log(`✓ ${SAMPLE_MODELS.length} helmet models`);

    const quantity = Number(process.env.SEED_SAMPLE_HELMETS ?? 50);
    let batch = await prisma.helmetBatch.findFirst({ where: { notes: SEED_BATCH_NOTE } });
    if (!batch) {
      const model = await prisma.helmetModel.findUniqueOrThrow({
        where: { sku: SAMPLE_MODELS[0]!.sku },
      });
      const [seq] = await prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT nextval('helmet_batch_code_seq') AS n`;
      const year = new Date().getUTCFullYear();
      batch = await prisma.helmetBatch.create({
        data: {
          batchCode: `BAT-${year}-${String(seq?.n ?? 1).padStart(5, '0')}`,
          helmetModelId: model.id,
          manufacturingDate: new Date(`${year}-01-15T00:00:00.000Z`),
          quantity,
          notes: SEED_BATCH_NOTE,
          createdBy: admin.id,
        },
      });
    }
    if (batch.generationStatus !== 'COMPLETED') {
      await prisma.helmetBatch.update({
        where: { id: batch.id },
        data: { generationStatus: 'GENERATING', generationStartedAt: new Date() },
      });
      await generator.run(batch.id, admin.id);
    }
    const generated = await prisma.helmet.count({ where: { batchId: batch.id } });
    console.log(`✓ batch ${batch.batchCode} with ${generated} helmets`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
