import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from '@helmet/types';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SafetyIdClaimDto {
  @ApiProperty({ example: 'SI-CD69-GXXR' })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  safetyCode: string;

  @ApiProperty({
    example: 'TR-K7PX-92LM-QW3E',
    description: 'Case, spaces and dashes are ignored.',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  transferCode: string;
}

export class SafetyIdClaimRegisterDto extends SafetyIdClaimDto {
  @ApiProperty({ example: 'rider@example.com' })
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

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
}

export class AdminSafetyIdQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Safety ID, Helmet ID, Customer ID or batch code' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({
    enum: ['GENERATED', 'PRINTED', 'ACTIVATED', 'ACTIVE', 'DEACTIVATED', 'REPLACED'],
  })
  @IsOptional()
  @IsIn(['GENERATED', 'PRINTED', 'ACTIVATED', 'ACTIVE', 'DEACTIVATED', 'REPLACED'])
  status?: 'GENERATED' | 'PRINTED' | 'ACTIVATED' | 'ACTIVE' | 'DEACTIVATED' | 'REPLACED';

  @ApiPropertyOptional({ enum: ['linked', 'standalone'] })
  @IsOptional()
  @IsIn(['linked', 'standalone'])
  link?: 'linked' | 'standalone';

  @ApiPropertyOptional({ enum: ['NORMAL', 'UNDER_REVIEW', 'COMPROMISED'] })
  @IsOptional()
  @IsIn(['NORMAL', 'UNDER_REVIEW', 'COMPROMISED'])
  qrIntegrity?: 'NORMAL' | 'UNDER_REVIEW' | 'COMPROMISED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  batchId?: string;
}

export class SafetyIdReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class SafetyIdLinkDto extends SafetyIdReasonDto {
  @ApiProperty({ example: 'HM-A8F3-KL9Q' })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  helmetCode: string;
}

export class SafetyIdIntegrityDto {
  @ApiProperty({ enum: ['NORMAL', 'UNDER_REVIEW', 'COMPROMISED'] })
  @IsIn(['NORMAL', 'UNDER_REVIEW', 'COMPROMISED'])
  status: 'NORMAL' | 'UNDER_REVIEW' | 'COMPROMISED';

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;
}

export class CreateSafetyIdBatchDto {
  @ApiProperty({ enum: ['STANDALONE', 'HELMET_LINKED'] })
  @IsIn(['STANDALONE', 'HELMET_LINKED'])
  mode: 'STANDALONE' | 'HELMET_LINKED';

  @ApiPropertyOptional({ minimum: 1, description: 'STANDALONE only' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity?: number;

  @ApiPropertyOptional({ description: 'HELMET_LINKED only: helmets of this batch get one each' })
  @IsOptional()
  @IsUUID()
  helmetBatchId?: string;

  @ApiPropertyOptional({
    description: 'Print design version to bind (default: the ACTIVE design). Immutable afterwards.',
  })
  @IsOptional()
  @IsUUID()
  printDesignId?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class SafetyIdBatchQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  search?: string;

  @ApiPropertyOptional({ enum: ['STANDALONE', 'HELMET_LINKED'] })
  @IsOptional()
  @IsIn(['STANDALONE', 'HELMET_LINKED'])
  mode?: 'STANDALONE' | 'HELMET_LINKED';
}

export class RevokeSafetyIdDto extends SafetyIdReasonDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  revokeSessions?: boolean;
}
