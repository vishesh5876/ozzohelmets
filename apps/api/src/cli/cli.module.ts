import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { AuditCoreModule } from '../modules/audit/audit.module';
import { EncryptionService } from '../security/encryption.service';
import { HashingService } from '../security/hashing.service';

/** Offline maintenance commands: database + crypto only (no HTTP, no Redis). */
@Module({
  imports: [AppConfigModule, PrismaModule, AuditCoreModule],
  providers: [HashingService, EncryptionService],
})
export class CliModule {}
