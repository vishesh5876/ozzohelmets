import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import type { EmergencyVisibilityInput } from '@helmet/types';

/** Full replacement of the public visibility choices. Saving counts as the explicit privacy review. */
export class UpdateEmergencyVisibilityDto implements EmergencyVisibilityInput {
  @ApiProperty() @IsBoolean() showName: boolean;
  @ApiProperty() @IsBoolean() showPhoto: boolean;
  @ApiProperty() @IsBoolean() showBloodGroup: boolean;
  @ApiProperty() @IsBoolean() showDateOfBirth: boolean;
  @ApiProperty() @IsBoolean() showGender: boolean;
  @ApiProperty() @IsBoolean() showAllergies: boolean;
  @ApiProperty() @IsBoolean() showMedicalConditions: boolean;
  @ApiProperty() @IsBoolean() showMedications: boolean;
  @ApiProperty() @IsBoolean() showEmergencyNotes: boolean;
  @ApiProperty() @IsBoolean() showOrganDonor: boolean;
  @ApiProperty() @IsBoolean() showEmergencyContacts: boolean;
}
