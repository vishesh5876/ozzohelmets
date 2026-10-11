import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from '@helmet/types';

const pinTransform = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]/g, '') : value;

/**
 * Identify the Safety ID by the QR token (scan flow) or the printed Safety ID (manual flow).
 * The Helmet ID is still accepted for Phase 8 activation cards (it selects the linked Safety ID).
 */
export class ActivationTargetDto {
  @ApiPropertyOptional({ description: 'Public token from the QR URL' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  publicToken?: string;

  @ApiPropertyOptional({ example: 'SI-CD69-GXXR' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  safetyCode?: string;

  @ApiPropertyOptional({ example: 'HM-A8F3-KL92' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  helmetCode?: string;
}

export class ActivationPinDto extends ActivationTargetDto {
  @ApiProperty({
    example: '73KP84QX',
    description: 'Activation PIN printed with the Safety ID (case and spaces ignored)',
  })
  @Transform(pinTransform)
  @Matches(/^[A-Z0-9]{4,16}$/, {
    message: 'pin must be the Activation PIN printed with your Safety ID',
  })
  pin: string;
}

export class RegisterActivationDto extends ActivationPinDto {
  @ApiProperty({
    example: 'rider@example.com',
    description:
      'Account email — the normal sign-in identifier. Not verified and not proof of ownership.',
  })
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
  email: string;

  @ApiProperty({
    format: 'password',
    minLength: 8,
    description: 'New account password (min 8 characters, passphrases welcome)',
  })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
}
