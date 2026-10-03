import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type HelmetModelDto, Permission } from '@helmet/types';
import type { PaginatedResult } from '../../common/http/api-response.interceptor';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import {
  CreateHelmetModelDto,
  HelmetModelQueryDto,
  UpdateHelmetModelDto,
} from './dto/helmet-model.dto';
import { HelmetModelsService } from './helmet-models.service';

@ApiTags('admin / helmet models')
@Controller('admin/helmet-models')
export class HelmetModelsController {
  constructor(private readonly models: HelmetModelsService) {}

  @Get()
  @AdminAuth(Permission.MODELS_READ)
  list(@Query() query: HelmetModelQueryDto): Promise<PaginatedResult<HelmetModelDto>> {
    return this.models.list(query);
  }

  @Get(':id')
  @AdminAuth(Permission.MODELS_READ)
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<HelmetModelDto> {
    return this.models.get(id);
  }

  @Post()
  @AdminAuth(Permission.MODELS_WRITE)
  create(
    @Body() dto: CreateHelmetModelDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<HelmetModelDto> {
    return this.models.create(dto, admin, meta);
  }

  @Patch(':id')
  @AdminAuth(Permission.MODELS_WRITE)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateHelmetModelDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<HelmetModelDto> {
    return this.models.update(id, dto, admin, meta);
  }
}
