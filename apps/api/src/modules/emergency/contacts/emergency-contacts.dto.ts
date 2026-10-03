import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateEmergencyContactDto {
  @ApiProperty({ example: 'Rajesh Sharma' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'Father' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  relationship: string;

  @ApiProperty({ example: '+919812345678' })
  @IsString()
  @MaxLength(32)
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  alternatePhone?: string | null;
}

export class UpdateEmergencyContactDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  relationship?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  alternatePhone?: string | null;
}

export class ReorderEmergencyContactsDto {
  @ApiProperty({
    type: [String],
    description: 'All active contact ids in the desired order (first = called first)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  ids: string[];
}
