import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { bootstrapAdmin } from './cli/bootstrap-admin';
import { CliModule } from './cli/cli.module';
import { encryptionStatus, rotateEncryption } from './cli/rotate-encryption';

/**
 * Offline maintenance CLI (runs inside the API image; never on application boot):
 *
 *   node dist/cli.js admin:bootstrap --email ops@example.com --name "Ops Lead"   (password on stdin)
 *   node dist/cli.js encryption:status
 *   node dist/cli.js encryption:rotate --keyring data|escrow [--batch 200] [--dry-run]
 */
const USAGE = `Usage:
  node dist/cli.js admin:bootstrap --email <email> --name <name>   (password read from stdin)
  node dist/cli.js encryption:status
  node dist/cli.js encryption:rotate --keyring data|escrow [--batch 200] [--dry-run]`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY)
    throw new Error('Pipe the password on stdin (e.g. read -rs PW; printf %s "$PW" | …).');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (
    !command ||
    !['admin:bootstrap', 'encryption:status', 'encryption:rotate'].includes(command)
  ) {
    console.error(USAGE);
    return 2;
  }
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
  try {
    switch (command) {
      case 'admin:bootstrap': {
        const id = await bootstrapAdmin(app, {
          email: arg('email') ?? '',
          name: arg('name') ?? '',
          password: await readStdin(),
        });
        console.log(
          `SUPER_ADMIN created (id ${id}). Sign in and enable your other admins from the console.`,
        );
        return 0;
      }
      case 'encryption:status':
        console.log(JSON.stringify(await encryptionStatus(app), null, 2));
        return 0;
      case 'encryption:rotate': {
        const keyring = arg('keyring');
        if (keyring !== 'data' && keyring !== 'escrow') {
          console.error(USAGE);
          return 2;
        }
        const batch = Number(arg('batch') ?? 200);
        const result = await rotateEncryption(app, {
          keyring,
          batchSize: Number.isInteger(batch) && batch > 0 && batch <= 5000 ? batch : 200,
          dryRun: process.argv.includes('--dry-run'),
        });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
    }
    return 2;
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  } finally {
    await app.close();
  }
}

void main().then((code) => process.exit(code));
