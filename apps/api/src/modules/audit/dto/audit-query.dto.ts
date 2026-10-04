import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Exact action, e.g. batch.export.manufacturing_csv' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  adminId?: string;

  @ApiPropertyOptional({ enum: ['ADMIN', 'CUSTOMER', 'SYSTEM'] })
  @IsOptional()
  @IsIn(['ADMIN', 'CUSTOMER', 'SYSTEM'])
  actorType?: 'ADMIN' | 'CUSTOMER' | 'SYSTEM';

  @ApiPropertyOptional({ description: 'Helmet ID (HM-…); resolved to the helmet entity' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  helmetCode?: string;

  @ApiPropertyOptional({ description: 'Customer ID (CU-…); entries about that customer' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerId?: string;

  @ApiPropertyOptional({ description: 'ISO date/time (inclusive)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date/time (exclusive)' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
