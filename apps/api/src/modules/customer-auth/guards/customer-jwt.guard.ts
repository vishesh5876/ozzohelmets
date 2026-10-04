import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import type { Request } from 'express';
import { ErrorCode } from '@helmet/types';
import { AppConfigService } from '../../../config/app-config.service';
import { AppException } from '../../../common/http/app.exception';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { CustomerTokenService } from '../customer-token.service';
import {
  type AuthenticatedCustomer,
  CUSTOMER_JWT_AUDIENCE,
  type CustomerJwtPayload,
} from '../customer-auth.types';

/**
 * Verifies customer access tokens. Uses a different secret and audience from admin tokens, so a
 * token of one kind can never authenticate the other. Re-loads the user so suspension is immediate,
 * and checks the session's revocation marker so a signed-out device loses access at once.
 */
@Injectable()
export class CustomerJwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly tokens: CustomerTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { customer?: AuthenticatedCustomer }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw AppException.unauthorized();

    let payload: CustomerJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<CustomerJwtPayload>(header.slice(7).trim(), {
        secret: this.config.get('JWT_CUSTOMER_ACCESS_SECRET'),
        audience: CUSTOMER_JWT_AUDIENCE,
        issuer: this.config.get('JWT_ISSUER'),
        algorithms: ['HS256'],
      });
    } catch (err) {
      if (err instanceof TokenExpiredError)
        throw AppException.unauthorized(ErrorCode.TOKEN_EXPIRED, 'Access token expired.');
      throw AppException.unauthorized();
    }
    if (payload.typ !== 'customer') throw AppException.unauthorized();
    // A revoked session (signed out remotely, password reset, suspension…) stops immediately.
    if (!payload.sid || (await this.tokens.isSessionRevoked(payload.sid)))
      throw AppException.unauthorized(
        ErrorCode.TOKEN_EXPIRED,
        'Session ended. Please sign in again.',
      );

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, mobile: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE')
      throw AppException.unauthorized(ErrorCode.ACCOUNT_DISABLED, 'Account is not active.');
    req.customer = { id: user.id, mobile: user.mobile, sessionId: payload.sid };
    return true;
  }
}
