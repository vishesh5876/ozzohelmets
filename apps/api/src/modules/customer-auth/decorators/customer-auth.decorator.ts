import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { CustomerJwtGuard } from '../guards/customer-jwt.guard';

/** Requires a valid customer access token. Resource ownership is checked in services. */
export function CustomerAuth() {
  return applyDecorators(
    UseGuards(CustomerJwtGuard),
    ApiBearerAuth('customer'),
    ApiUnauthorizedResponse({ description: 'Missing/invalid customer access token' }),
  );
}
