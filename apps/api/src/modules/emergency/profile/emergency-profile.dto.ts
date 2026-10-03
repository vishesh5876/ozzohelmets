import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BLOOD_GROUPS, type BloodGroup, GENDERS, type Gender } from '@helmet/types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimList = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value
        .map((v: unknown) => (typeof v === 'string' ? v.trim() : v))
        .filter((v: unknown) => v !== '')
    : value;

/**
 * Partial update: omitted keys are left unchanged, `null` clears a value. Lists replace the
 * stored list. Medical fields are encrypted before storage.
 */
export class UpdateEmergencyProfileDto {
  @ApiPropertyOptional({ nullable: true, maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string | null;

  @ApiPropertyOptional({ enum: BLOOD_GROUPS, nullable: true })
  @IsOptional()
  @IsIn(BLOOD_GROUPS)
  bloodGroup?: BloodGroup | null;

  @ApiPropertyOptional({ example: '1990-05-14', nullable: true })
  @IsOptional()
  @IsDateString({ strict: true })
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ enum: GENDERS, nullable: true })
  @IsOptional()
  @IsIn(GENDERS)
  gender?: Gender | null;

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @IsOptional()
  @Transform(trimList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  allergies?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @IsOptional()
  @Transform(trimList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  medicalConditions?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: 20 })
  @IsOptional()
  @Transform(trimList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  medications?: string[];

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  emergencyNotes?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsBoolean()
  organDonor?: boolean | null;
}
