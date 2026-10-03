import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminTokenService } from './admin-token.service';
import { AdminJwtGuard } from './guards/admin-jwt.guard';
import { RbacGuard } from './guards/rbac.guard';

/** Global so any module can use `@AdminAuth()` without re-importing guard dependencies. */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminTokenService, AdminJwtGuard, RbacGuard],
  exports: [AdminTokenService, AdminJwtGuard, RbacGuard, JwtModule],
})
export class AdminAuthModule {}
