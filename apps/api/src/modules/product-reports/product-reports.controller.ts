import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, type ProductReportDto } from '@helmet/types';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import {
  CreateProductReportDto,
  ProductReportQueryDto,
  UpdateProductReportDto,
} from './dto/product-report.dto';
import { ProductReportsService } from './product-reports.service';

@ApiTags('public')
@Controller('public/product-reports')
export class PublicProductReportsController {
  constructor(private readonly reports: ProductReportsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit('auth')
  @ApiOperation({ summary: 'Report a problem with a product (no account; heavily rate-limited).' })
  create(
    @Body() dto: CreateProductReportDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ received: true }> {
    return this.reports.create(dto, meta);
  }
}

@ApiTags('admin / product reports')
@Controller('admin/product-reports')
export class AdminProductReportsController {
  constructor(private readonly reports: ProductReportsService) {}

  @Get()
  @AdminAuth(Permission.PRODUCT_REPORT_VIEW)
  list(@Query() q: ProductReportQueryDto): Promise<PaginatedResult<ProductReportDto>> {
    return this.reports.list(q.status, q.page, q.pageSize);
  }

  @Patch(':id')
  @AdminAuth(Permission.PRODUCT_REPORT_MANAGE)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProductReportDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ProductReportDto> {
    return this.reports.update(admin, id, dto.status, dto.note, meta);
  }
}
