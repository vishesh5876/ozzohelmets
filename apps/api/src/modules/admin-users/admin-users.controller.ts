import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminRole, type AdminUserDto, Permission } from '@helmet/types';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { Roles } from '../admin-auth/decorators/roles.decorator';
import { AdminUsersService } from './admin-users.service';
import { CreateAdminUserDto, UpdateAdminUserDto } from './dto/admin-user.dto';

@ApiTags('admin / users')
@Controller('admin/users')
@AdminAuth(Permission.ADMIN_USERS_MANAGE)
@Roles(AdminRole.SUPER_ADMIN)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(): Promise<AdminUserDto[]> {
    return this.users.list();
  }

  @Post()
  create(
    @Body() dto: CreateAdminUserDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminUserDto> {
    return this.users.create(dto, admin, meta);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAdminUserDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminUserDto> {
    return this.users.update(id, dto, admin, meta);
  }
}
