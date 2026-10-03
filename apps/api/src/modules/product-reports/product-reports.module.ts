import { Module } from '@nestjs/common';
import {
  AdminProductReportsController,
  PublicProductReportsController,
} from './product-reports.controller';
import { ProductReportsService } from './product-reports.service';

/** Phase 4: public product-problem reports (counterfeit-reporting foundation). */
@Module({
  controllers: [PublicProductReportsController, AdminProductReportsController],
  providers: [ProductReportsService],
})
export class ProductReportsModule {}
