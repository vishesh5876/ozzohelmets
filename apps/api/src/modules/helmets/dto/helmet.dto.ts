import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { HELMET_STATUSES, type HelmetStatus } from '@helmet/types';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class HelmetQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Helmet ID (HM-XXXX-XXXX, partial ok) or serial number' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({
    enum: HELMET_STATUSES,
    isArray: true,
    description: 'Comma-separated list allowed',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsIn(HELMET_STATUSES, { each: true })
  status?: HelmetStatus[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  helmetModelId?: string;

  @ApiPropertyOptional({ description: 'true = activated helmets only, false = never activated' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  activated?: boolean;
}

export class ChangeHelmetStatusDto {
  @ApiProperty({ enum: HELMET_STATUSES })
  @IsIn(HELMET_STATUSES)
  status: HelmetStatus;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  reason?: string;
}
