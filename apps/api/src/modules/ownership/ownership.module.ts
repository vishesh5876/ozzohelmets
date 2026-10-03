import { Module } from '@nestjs/common';
import { CustomerHelmetsModule } from '../customer-helmets/customer-helmets.module';
import { HelmetsModule } from '../helmets/helmets.module';
import { OwnershipAdminService } from './ownership-admin.service';
import { OwnerTransferController, TransferClaimController } from './transfer.controller';
import { TransferService } from './transfer.service';

/** Ownership periods, transfers and (exceptional) revocation (Phase 3). */
@Module({
  imports: [HelmetsModule, CustomerHelmetsModule],
  controllers: [OwnerTransferController, TransferClaimController],
  providers: [TransferService, OwnershipAdminService],
  exports: [TransferService, OwnershipAdminService],
})
export class OwnershipModule {}
