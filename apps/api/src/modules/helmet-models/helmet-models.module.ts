import { Module } from '@nestjs/common';
import { HelmetModelsController } from './helmet-models.controller';
import { HelmetModelsService } from './helmet-models.service';

@Module({
  controllers: [HelmetModelsController],
  providers: [HelmetModelsService],
  exports: [HelmetModelsService],
})
export class HelmetModelsModule {}
