import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { HelmetModelStatus } from '@helmet/types';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateHelmetModelDto {
  @ApiProperty({ example: 'Roadster X1' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'RX1-MATTE-BLK', description: 'Uppercase letters, digits and dashes' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9][A-Z0-9-]{1,63}$/, {
    message: 'sku must be 2-64 chars of A-Z, 0-9 and dashes',
  })
  sku: string;

  @ApiProperty({ example: 'Ozzo' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brand: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class UpdateHelmetModelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brand?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: HelmetModelStatus;
}

export class HelmetModelQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search name or SKU' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: HelmetModelStatus;
}
