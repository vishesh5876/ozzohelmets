import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DamageReason, ReplacementReason } from '@helmet/types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class MarkDamagedDto {
  @ApiPropertyOptional({ enum: Object.values(DamageReason) })
  @IsOptional()
  @IsIn(Object.values(DamageReason))
  reason?: DamageReason;

  @ApiPropertyOptional({ maxLength: 200, description: 'Optional short note. No medical details.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class RetireHelmetDto {
  @ApiProperty({ description: 'Type the Helmet ID to confirm permanent retirement.' })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  confirmHelmetCode: string;
}

export class AdminReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class RevokeOwnershipDto extends AdminReasonDto {
  @ApiProperty({ enum: ['ACTIVATED', 'DEACTIVATED'] })
  @IsIn(['ACTIVATED', 'DEACTIVATED'])
  targetStatus: 'ACTIVATED' | 'DEACTIVATED';

  @ApiPropertyOptional({ description: 'Also sign the customer out everywhere.' })
  @IsOptional()
  @IsBoolean()
  revokeSessions?: boolean;
}

export class LinkReplacementDto {
  @ApiProperty()
  @IsUUID()
  originalHelmetId: string;

  @ApiProperty({ example: 'HM-NEW2-XXXX' })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  replacementHelmetCode: string;

  @ApiProperty({ enum: Object.values(ReplacementReason) })
  @IsIn(Object.values(ReplacementReason))
  reason: ReplacementReason;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    example: '2029-09-30',
    description:
      'Override the replacement warranty end date (default policy: keep the original end date).',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  replacementWarrantyEndDate?: string;
}
