import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ADMIN_ROLES, type AdminRole, type AdminUserStatus } from '@helmet/types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateAdminUserDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 12, description: 'At least 12 chars incl. upper, lower and a digit' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'password must contain upper, lower case letters and a digit',
  })
  password: string;

  @ApiProperty({ enum: ADMIN_ROLES })
  @IsIn(ADMIN_ROLES)
  role: AdminRole;
}

export class UpdateAdminUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: ADMIN_ROLES })
  @IsOptional()
  @IsIn(ADMIN_ROLES)
  role?: AdminRole;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: AdminUserStatus;
}
