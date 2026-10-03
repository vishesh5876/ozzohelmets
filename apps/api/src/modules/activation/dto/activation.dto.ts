import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]/g, '') : value;

/** Identify the helmet by the QR token (scan flow) or the printed Helmet ID (manual flow). */
export class ActivationTargetDto {
  @ApiPropertyOptional({ description: 'Public token from the QR URL' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  publicToken?: string;

  @ApiPropertyOptional({ example: 'HM-A8F3-KL92' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  helmetCode?: string;
}

export class CompleteActivationDto extends ActivationTargetDto {
  @ApiProperty({
    example: '73KP84QX',
    description: 'Activation PIN from the helmet label (case/spaces ignored)',
  })
  @Transform(upper)
  @Matches(/^[A-Z0-9]{4,16}$/, { message: 'pin must be the code printed on your helmet label' })
  pin: string;
}
