import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type { BatchGenerationStatus } from '@helmet/types';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class CreateBatchDto {
  @ApiProperty()
  @IsUUID()
  helmetModelId: string;

  @ApiProperty({ example: '2026-10-01', description: 'ISO date (YYYY-MM-DD)' })
  @IsDateString({ strict: true })
  manufacturingDate: string;

  @ApiProperty({ example: 100, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({
    example: 'BAT-2026-00045',
    description: 'Optional; generated as BAT-<year>-<seq> when omitted',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() || undefined : value,
  )
  @Matches(/^[A-Z0-9][A-Z0-9-]{2,31}$/, {
    message: 'batchCode must be 3-32 chars of A-Z, 0-9 and dashes',
  })
  batchCode?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class BatchQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search batch code' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(32)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  helmetModelId?: string;

  @ApiPropertyOptional({ enum: ['PENDING', 'GENERATING', 'COMPLETED', 'FAILED'] })
  @IsOptional()
  @IsIn(['PENDING', 'GENERATING', 'COMPLETED', 'FAILED'])
  generationStatus?: BatchGenerationStatus;
}
