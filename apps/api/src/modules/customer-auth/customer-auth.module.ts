import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OtpModule } from '../otp/otp.module';
import { CustomerAuthController } from './customer-auth.controller';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerTokenService } from './customer-token.service';
import { CustomerJwtGuard } from './guards/customer-jwt.guard';

/** Global so feature modules can use `@CustomerAuth()` without re-importing guard dependencies. */
@Global()
@Module({
  imports: [JwtModule.register({}), OtpModule],
  controllers: [CustomerAuthController],
  providers: [CustomerAuthService, CustomerTokenService, CustomerJwtGuard],
  exports: [CustomerJwtGuard, CustomerAuthService, JwtModule],
})
export class CustomerAuthModule {}
