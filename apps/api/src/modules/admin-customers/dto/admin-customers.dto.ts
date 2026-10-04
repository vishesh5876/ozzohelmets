import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { type AdminCustomerStatusAction, type UserStatus } from '@helmet/types';
import { plainText } from '../../../common/utils/plain-text';

const clean = ({ value }: { value: unknown }) => plainText(value);

export class CustomerSearchQueryDto {
  @ApiPropertyOptional({ description: 'Customer ID, Helmet ID, email (partial) or name (partial)' })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  q?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED', 'LOCKED', 'DELETED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'LOCKED', 'DELETED'])
  status?: UserStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class CustomerStatusChangeDto {
  @ApiProperty({ enum: ['SUSPEND', 'LOCK', 'RESTORE'] })
  @IsIn(['SUSPEND', 'LOCK', 'RESTORE'])
  action: AdminCustomerStatusAction;

  @ApiProperty({ minLength: 5, maxLength: 300, description: 'Internal support note (required)' })
  @Transform(clean)
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  reason: string;
}

export class CustomerReasonDto {
  @ApiProperty({ minLength: 5, maxLength: 300 })
  @Transform(clean)
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  reason: string;
}

/** Irreversible / last-resort actions: reason + the Customer ID typed again. */
export class ConfirmedCustomerActionDto {
  @ApiProperty({ minLength: 10, maxLength: 500 })
  @Transform(clean)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @ApiProperty({ example: 'CU-K7PX-92LM', description: 'Type the Customer ID again to confirm' })
  @IsString()
  @MaxLength(32)
  confirmCustomerId: string;
}

export class PrivacyRequestReviewDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(clean)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PrivacyRequestListQueryDto {
  @ApiPropertyOptional({ enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED'])
  status?: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'COMPLETED' | 'CANCELLED';
}

export class SecurityEventQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  type?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
