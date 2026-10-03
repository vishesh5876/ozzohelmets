import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProductReportReason, ProductReportStatus } from '@helmet/types';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { plainText } from '../../../common/utils/plain-text';

const plain = ({ value }: { value: unknown }) => plainText(value, true);

export class CreateProductReportDto {
  @ApiPropertyOptional({ description: 'QR token from the scanned URL' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  publicToken?: string;

  @ApiPropertyOptional({ example: 'HM-A8F3-KL92' })
  @IsOptional()
  @Transform(plain)
  @IsString()
  @MaxLength(32)
  helmetCode?: string;

  @ApiProperty({ enum: Object.values(ProductReportReason) })
  @IsIn(Object.values(ProductReportReason))
  reason: ProductReportReason;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(plain)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Optional, only if you want to be contacted' })
  @IsOptional()
  @Transform(plain)
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string;
}

export class ProductReportQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: Object.values(ProductReportStatus) })
  @IsOptional()
  @IsIn(Object.values(ProductReportStatus))
  status?: ProductReportStatus;
}

export class UpdateProductReportDto {
  @ApiProperty({ enum: Object.values(ProductReportStatus) })
  @IsIn(Object.values(ProductReportStatus))
  status: ProductReportStatus;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(plain)
  @IsString()
  @MaxLength(500)
  note?: string;
}
