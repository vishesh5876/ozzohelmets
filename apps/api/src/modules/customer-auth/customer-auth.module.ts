import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CustomerAuthController } from './customer-auth.controller';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerAccountsService } from './customer-accounts.service';
import { CustomerCredentialsService } from './customer-credentials.service';
import { CustomerTokenService } from './customer-token.service';
import { CustomerJwtGuard } from './guards/customer-jwt.guard';

/** Global so feature modules can use `@CustomerAuth()` without re-importing guard dependencies. */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [CustomerAuthController],
  providers: [
    CustomerAuthService,
    CustomerCredentialsService,
    CustomerAccountsService,
    CustomerTokenService,
    CustomerJwtGuard,
  ],
  exports: [
    CustomerJwtGuard,
    CustomerAuthService,
    CustomerCredentialsService,
    CustomerAccountsService,
    CustomerTokenService,
    JwtModule,
  ],
})
export class CustomerAuthModule {}
