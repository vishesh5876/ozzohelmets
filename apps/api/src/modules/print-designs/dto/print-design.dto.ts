import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ARTWORK_OFFSET_RANGE_MM, ARTWORK_SCALE_RANGE } from '@helmet/types';
import { Max, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Uniform scale + offsets only: there is deliberately no separate X/Y scale. */
class PositionFields {
  @ApiPropertyOptional({
    minimum: ARTWORK_SCALE_RANGE.min,
    maximum: ARTWORK_SCALE_RANGE.max,
    default: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(ARTWORK_SCALE_RANGE.min)
  @Max(ARTWORK_SCALE_RANGE.max)
  scalePercent?: number;

  @ApiPropertyOptional({ description: 'mm', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-ARTWORK_OFFSET_RANGE_MM)
  @Max(ARTWORK_OFFSET_RANGE_MM)
  offsetXMm?: number;

  @ApiPropertyOptional({ description: 'mm', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-ARTWORK_OFFSET_RANGE_MM)
  @Max(ARTWORK_OFFSET_RANGE_MM)
  offsetYMm?: number;
}

export class CreatePrintDesignDto extends PositionFields {
  @ApiProperty({ example: 'OZZO Emergency Black' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty()
  @IsUUID()
  baseArtworkFileId: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  coverArtworkFileId?: string | null;
}

export class UpdatePrintDesignDto extends PositionFields {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  baseArtworkFileId?: string;

  @ApiPropertyOptional({ nullable: true, description: 'null removes the custom cover' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  coverArtworkFileId?: string | null;
}

export class UploadArtworkDto {
  @ApiProperty({ enum: ['base', 'cover'] })
  @IsIn(['base', 'cover'])
  role: 'base' | 'cover';

  @ApiPropertyOptional({ description: 'SUPER_ADMIN only: accept a low-resolution PNG for tests' })
  @IsOptional()
  @IsIn(['true', 'false'])
  testOnly?: 'true' | 'false';
}

export class PrintDesignListQueryDto {
  @ApiPropertyOptional({ enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'ACTIVE', 'ARCHIVED'])
  status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
}
