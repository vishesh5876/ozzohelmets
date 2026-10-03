import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  PurchaseChannel,
  WarrantyCorrectionReason,
  WarrantyStatus,
  WarrantyVoidReason,
} from '@helmet/types';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { plainText } from '../../../common/utils/plain-text';

/** Trims and strips control characters from short free text (rendered as text, never HTML). */
const clean = ({ value }: { value: unknown }) => plainText(value);
const cleanNullable = ({ value }: { value: unknown }) => (value === null ? null : clean({ value }));

export class RegisterWarrantyDto {
  @ApiProperty({ example: '2026-09-28', description: 'Calendar date (YYYY-MM-DD)' })
  @IsDateString({ strict: true })
  purchaseDate: string;

  @ApiPropertyOptional({ enum: Object.values(PurchaseChannel) })
  @IsOptional()
  @IsIn(Object.values(PurchaseChannel))
  purchaseChannel?: PurchaseChannel;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(clean)
  @IsString()
  @MaxLength(120)
  sellerName?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @Transform(clean)
  @IsString()
  @MaxLength(80)
  sellerCity?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @Transform(clean)
  @IsString()
  @MaxLength(64)
  invoiceNumber?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(clean)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class WarrantyQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Helmet ID, Customer ID, serial number or invoice number' })
  @IsOptional()
  @Transform(clean)
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ enum: Object.values(WarrantyStatus) })
  @IsOptional()
  @IsIn(Object.values(WarrantyStatus))
  status?: WarrantyStatus;
}

export class CorrectWarrantyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({ strict: true })
  purchaseDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({ strict: true })
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string;

  @ApiPropertyOptional({ enum: Object.values(PurchaseChannel), nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(Object.values(PurchaseChannel))
  purchaseChannel?: PurchaseChannel | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(cleanNullable)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(120)
  sellerName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(cleanNullable)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(64)
  invoiceNumber?: string | null;

  @ApiProperty({ enum: Object.values(WarrantyCorrectionReason) })
  @IsIn(Object.values(WarrantyCorrectionReason))
  reasonCode: WarrantyCorrectionReason;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(clean)
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class VoidWarrantyDto {
  @ApiProperty({ enum: Object.values(WarrantyVoidReason) })
  @IsIn(Object.values(WarrantyVoidReason))
  reason: WarrantyVoidReason;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(clean)
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class RestoreWarrantyDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(clean)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  note?: string;
}
