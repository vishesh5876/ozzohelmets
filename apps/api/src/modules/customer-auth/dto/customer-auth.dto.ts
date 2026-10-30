import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from '@helmet/types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * `identifier` = account email (normal), Customer ID or a currently owned Helmet ID.
 * `helmetCode` is the Phase 2/3 field name (still accepted).
 */
export class CustomerLoginDto {
  @ApiPropertyOptional({
    example: 'rider@example.com',
    description: 'Account email, Customer ID, or any Helmet ID currently owned by the account',
  })
  @ValidateIf((o: CustomerLoginDto) => o.helmetCode === undefined)
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
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
  @ApiPropertyOptional({
    example: 'CU-K7PX-92LM',
    description: 'Account email, Customer ID or owned Helmet ID',
  })
  @ValidateIf((o: RecoverDto) => o.helmetCode === undefined)
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
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

export class EmailDto {
  @ApiProperty({ example: 'rider@example.com' })
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
  email: string;
}

const CODE_DESCRIPTION = 'Six-digit code from the email (spaces ignored).';

export class EmailCodeDto extends EmailDto {
  @ApiProperty({ example: '482913', description: CODE_DESCRIPTION })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, '') : value,
  )
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the six-digit code from the email.' })
  code: string;
}

export class NewEmailDto {
  @ApiProperty({ example: 'new@example.com' })
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
  newEmail: string;
}

/** Email change: password + the code emailed to the new address. */
export class ChangeEmailDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword: string;

  @ApiProperty({ example: 'new@example.com' })
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
  newEmail: string;

  @ApiPropertyOptional({
    example: 'new@example.com',
    description: 'If sent, must match `newEmail`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
  confirmEmail?: string;

  @ApiPropertyOptional({
    example: '482913',
    description: `${CODE_DESCRIPTION} Sent to the new address by POST /customer/auth/email/change-code.`,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, '') : value,
  )
  @IsString()
  @MaxLength(12)
  emailCode?: string;
}

/**
 * Owner-provided details. The account email is changed only via POST /customer/auth/email.
 * Mobile is collected at sign-up; it can be changed but not removed. It is NOT verified and never
 * used for auth.
 */
export class UpdateCustomerDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string | null;

  @ApiPropertyOptional({ example: '+91 98765 43210' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(32)
  mobile?: string;
}
