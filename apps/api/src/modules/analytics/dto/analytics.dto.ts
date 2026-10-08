import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import {
  QrIntegrityStatus,
  RiskAlertStatus,
  RiskAlertType,
  RiskLevel,
} from '@helmet/types';
import { plainText } from '../../../common/utils/plain-text';

export class AnalyticsRangeQueryDto {
  @ApiPropertyOptional({ enum: ['today', '7d', '30d', 'custom'], default: '30d' })
  @IsOptional()
  @IsIn(['today', '7d', '30d', 'custom'])
  range?: 'today' | '7d' | '30d' | 'custom';

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

export class CursorQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class HelmetActivityQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  minLevel?: RiskLevel;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  includeResolved?: boolean;
}

export class RiskAlertQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: [...Object.values(RiskAlertStatus), 'OPEN_ANY'] })
  @IsOptional()
  @IsIn([...Object.values(RiskAlertStatus), 'OPEN_ANY'])
  status?: RiskAlertStatus | 'OPEN_ANY';

  @ApiPropertyOptional({ enum: Object.values(RiskAlertType) })
  @IsOptional()
  @IsIn(Object.values(RiskAlertType))
  type?: RiskAlertType;
}

export class UpdateRiskAlertDto {
  @ApiPropertyOptional({ enum: Object.values(RiskAlertStatus) })
  @IsOptional()
  @IsIn(Object.values(RiskAlertStatus))
  status?: RiskAlertStatus;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  assignedAdminId?: string | null;

  @ApiPropertyOptional({ maxLength: 500, description: 'Required to resolve or dismiss' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => plainText(value, true))
  @IsString()
  @MaxLength(500)
  resolutionReason?: string;
}

export class QrIntegrityDto {
  @ApiProperty({ enum: Object.values(QrIntegrityStatus) })
  @IsIn(Object.values(QrIntegrityStatus))
  status: QrIntegrityStatus;

  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => plainText(value, true))
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  note: string;
}
