import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '@helmet/types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** `identifier` = Helmet ID or Customer ID. `helmetCode` is the Phase 2/3 field name (still accepted). */
export class CustomerLoginDto {
  @ApiPropertyOptional({
    example: 'CU-K7PX-92LM',
    description: 'Customer ID, or any Helmet ID currently owned by the account',
  })
  @ValidateIf((o: CustomerLoginDto) => o.helmetCode === undefined)
  @IsString()
  @MaxLength(32)
  identifier?: string;

  @ApiPropertyOptional({ deprecated: true, description: 'Alias of `identifier`' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  helmetCode?: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class RecoverDto {
  @ApiPropertyOptional({ example: 'CU-K7PX-92LM', description: 'Customer ID or owned Helmet ID' })
  @ValidateIf((o: RecoverDto) => o.helmetCode === undefined)
  @IsString()
  @MaxLength(32)
  identifier?: string;

  @ApiPropertyOptional({ deprecated: true, description: 'Alias of `identifier`' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  helmetCode?: string;

  @ApiProperty({ example: 'RK-9KPX-V7MT-42QF' })
  @IsString()
  @MaxLength(40)
  recoveryCode: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Single-use token from POST /customer/auth/recover' })
  @IsString()
  @MinLength(20)
  @MaxLength(128)
  resetToken: string;

  @ApiProperty({ format: 'password', minLength: 8 })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword: string;

  @ApiProperty({ format: 'password', minLength: 8 })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}

export class ConfirmPasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

/** Optional, owner-provided contact details. They are NOT verified and never used for auth. */
export class UpdateCustomerDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || null : value,
  )
  @ValidateIf((_o, v) => v !== null)
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(32)
  mobile?: string | null;
}
