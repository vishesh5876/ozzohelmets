import { Module } from '@nestjs/common';
import { ExportsModule } from '../exports/exports.module';
import { HelmetsModule } from '../helmets/helmets.module';
import { BatchGenerationService } from './batch-generation.service';
import { BatchesController } from './batches.controller';
import { BatchesService } from './batches.service';

@Module({
  imports: [HelmetsModule, ExportsModule],
  controllers: [BatchesController],
  providers: [BatchesService, BatchGenerationService],
  exports: [BatchGenerationService],
})
export class BatchesModule {}
