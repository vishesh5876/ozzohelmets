import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import type { Request } from 'express';
import { ErrorCode } from '@helmet/types';
import { AppConfigService } from '../../../config/app-config.service';
import { AppException } from '../../../common/http/app.exception';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  ADMIN_JWT_AUDIENCE,
  type AdminJwtPayload,
  type AuthenticatedAdmin,
} from '../admin-auth.types';

/**
 * Verifies the admin access JWT and re-loads the admin so that disabling an account or
 * changing a role takes effect immediately rather than at token expiry.
 */
@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { admin?: AuthenticatedAdmin }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw AppException.unauthorized();
    const token = header.slice(7).trim();

    let payload: AdminJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminJwtPayload>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        audience: ADMIN_JWT_AUDIENCE,
        issuer: this.config.get('JWT_ISSUER'),
        algorithms: ['HS256'],
      });
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        throw AppException.unauthorized(ErrorCode.TOKEN_EXPIRED, 'Access token expired.');
      }
      throw AppException.unauthorized();
    }
    if (payload.typ !== 'admin') throw AppException.unauthorized();

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    if (!admin || admin.status !== 'ACTIVE') {
      throw AppException.unauthorized(ErrorCode.ACCOUNT_DISABLED, 'Account is not active.');
    }
    req.admin = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
    return true;
  }
}
