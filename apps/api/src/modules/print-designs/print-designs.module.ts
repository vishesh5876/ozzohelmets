import { Module } from '@nestjs/common';
import { PrintModule } from '../print/print.module';
import { PrintDesignsController } from './print-designs.controller';
import { PrintDesignsService } from './print-designs.service';

/** Admin-controlled Safety ID artwork (versioned); the print engine keeps all dynamic geometry. */
@Module({
  imports: [PrintModule],
  controllers: [PrintDesignsController],
  providers: [PrintDesignsService],
  exports: [PrintDesignsService],
})
export class PrintDesignsModule {}
