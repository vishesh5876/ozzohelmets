import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { plainText } from '../../../common/utils/plain-text';

export class DeletionRequestDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'Optional reason (helps support).' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => plainText(value, true))
  @IsString()
  @MaxLength(500)
  reason?: string;
}
