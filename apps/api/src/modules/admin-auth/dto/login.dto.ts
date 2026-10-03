import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class AdminLoginDto {
  @ApiProperty({ example: 'superadmin@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password: string;
}

export class ReauthenticateDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password: string;
}
