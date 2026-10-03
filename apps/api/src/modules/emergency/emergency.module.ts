import { Module } from '@nestjs/common';
import { EncryptionService } from '../../security/encryption.service';
import { HelmetsModule } from '../helmets/helmets.module';
import { EmergencyContactsController } from './contacts/emergency-contacts.controller';
import { EmergencyContactsService } from './contacts/emergency-contacts.service';
import { ProfileCipher } from './domain/profile-cipher';
import { PROFILE_CIPHER } from './emergency.tokens';
import { EmergencyProfileController } from './profile/emergency-profile.controller';
import { HelmetEmergencyController } from './profile/helmet-emergency.controller';
import { EmergencyProfileService } from './profile/emergency-profile.service';
import { EmergencyVisibilityController } from './visibility/emergency-visibility.controller';
import { EmergencyVisibilityService } from './visibility/emergency-visibility.service';

/** Customer emergency data: profile (encrypted medical fields), contacts and public visibility. */
@Module({
  imports: [HelmetsModule],
  controllers: [
    EmergencyProfileController,
    EmergencyContactsController,
    EmergencyVisibilityController,
    HelmetEmergencyController,
  ],
  providers: [
    EmergencyProfileService,
    EmergencyContactsService,
    EmergencyVisibilityService,
    {
      provide: PROFILE_CIPHER,
      inject: [EncryptionService],
      useFactory: (enc: EncryptionService) => new ProfileCipher(enc.data),
    },
  ],
  exports: [EmergencyProfileService, EmergencyContactsService],
})
export class EmergencyModule {}
