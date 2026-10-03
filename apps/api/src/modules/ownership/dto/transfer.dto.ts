import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '@helmet/types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class TransferClaimDto {
  @ApiProperty({ example: 'HM-A8F3-KL9Q' })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  helmetCode: string;

  @ApiProperty({
    example: 'TR-K7PX-92LM-QW3E',
    description: 'Case, spaces and dashes are ignored.',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  transferCode: string;
}

export class TransferClaimRegisterDto extends TransferClaimDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
}
