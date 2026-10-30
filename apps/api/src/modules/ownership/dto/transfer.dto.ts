import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from '@helmet/types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class TransferClaimDto {
  @ApiProperty({ example: 'HM-A8F3-KL9Q' })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  helmetCode: string;

  @ApiProperty({
    example: 'TR-K7PX-92LM-QW3E',
    description: 'Case, spaces and dashes are ignored.',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  transferCode: string;
}

export class TransferClaimRegisterDto extends TransferClaimDto {
  @ApiProperty({ example: 'rider@example.com', description: 'Account email (sign-in identifier)' })
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
  email: string;

  @ApiProperty({
    example: '+91 98765 43210',
    description:
      'Owner mobile number. Without a country code it is read in DEFAULT_PHONE_REGION (IN); stored in E.164. Not verified, never a sign-in identifier, never on the public page.',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  mobile: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  @ApiPropertyOptional({
    description:
      'Proof that the email was verified: from POST /customer/auth/email/verify-code. Required unless EMAIL_VERIFICATION_REQUIRED=false.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  emailProof?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
}
