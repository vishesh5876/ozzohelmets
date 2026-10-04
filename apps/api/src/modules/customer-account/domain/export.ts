import type {
  AccountDeletionRequestDto,
  CustomerDataExportDto,
  CustomerSecurityEventType,
  HelmetStatus,
  OwnershipAcquisition,
  OwnershipStatus,
  UserStatus,
  WarrantyStatus,
} from '@helmet/types';
import type { DecryptedProfile } from '../../emergency/domain/decrypted-profile';

export interface ExportSource {
  user: {
    customerCode: string;
    name: string | null;
    email: string | null;
    emailVerified: boolean;
    mobile: string | null;
    status: UserStatus;
    createdAt: Date;
    lastLoginAt: Date | null;
    passwordChangedAt: Date | null;
    recoveryCodeCreatedAt: Date | null;
  };
  helmets: {
    helmetCode: string;
    model: string;
    brand: string;
    status: HelmetStatus;
    emergencySharing: boolean;
  }[];
  ownerships: {
    helmetCode: string;
    status: OwnershipStatus;
    acquiredVia: OwnershipAcquisition;
    from: Date;
    until: Date | null;
  }[];
  profile: DecryptedProfile | null;
  contacts: {
    name: string;
    relationship: string;
    phone: string;
    alternatePhone: string | null;
    priority: number;
  }[];
  visibility: Record<string, unknown> | null;
  warranties: {
    helmetCode: string;
    status: WarrantyStatus;
    purchaseDate: Date | null;
    startDate: Date | null;
    endDate: Date | null;
    /** Only the registrant receives their own purchase details. */
    isRegistrant: boolean;
    sellerName: string | null;
    invoiceNumber: string | null;
  }[];
  events: { type: CustomerSecurityEventType; userAgentSummary: string | null; createdAt: Date }[];
  deletionRequests: AccountDeletionRequestDto[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const VISIBILITY_KEYS = [
  'showName',
  'showPhoto',
  'showBloodGroup',
  'showDateOfBirth',
  'showGender',
  'showAllergies',
  'showMedicalConditions',
  'showMedications',
  'showEmergencyNotes',
  'showOrganDonor',
  'showEmergencyContacts',
  'confirmedAt',
] as const;

/**
 * Builds the customer's export from an explicit allow-list. Every field is copied by name, so a
 * new column (a hash, a token, an internal id, an admin note) can never leak into it by default.
 */
export function buildCustomerExport(src: ExportSource, now = new Date()): CustomerDataExportDto {
  const p = src.profile;
  const visibility: Record<string, unknown> | null = src.visibility
    ? Object.fromEntries(
        VISIBILITY_KEYS.filter((k) => k in src.visibility!).map((k) => {
          const v = src.visibility![k];
          return [k, v instanceof Date ? v.toISOString() : v];
        }),
      )
    : null;
  return {
    format: 'helmet-platform-customer-export',
    version: 1,
    exportedAt: now.toISOString(),
    account: {
      customerId: src.user.customerCode,
      name: src.user.name,
      email: src.user.email,
      emailVerified: src.user.emailVerified,
      mobile: src.user.mobile,
      status: src.user.status,
      createdAt: src.user.createdAt.toISOString(),
      lastLoginAt: iso(src.user.lastLoginAt),
      passwordChangedAt: iso(src.user.passwordChangedAt),
      recoveryCodeCreatedAt: iso(src.user.recoveryCodeCreatedAt),
    },
    helmets: src.helmets.map((h) => ({
      helmetCode: h.helmetCode,
      model: h.model,
      brand: h.brand,
      status: h.status,
      emergencySharing: h.emergencySharing,
    })),
    ownershipHistory: src.ownerships.map((o) => ({
      helmetCode: o.helmetCode,
      status: o.status,
      acquiredVia: o.acquiredVia,
      from: o.from.toISOString(),
      until: iso(o.until),
    })),
    emergencyProfile: p
      ? {
          name: p.name,
          bloodGroup: p.bloodGroup,
          gender: p.gender,
          dateOfBirth: p.dateOfBirth,
          organDonor: p.organDonor,
          allergies: p.allergies,
          medicalConditions: p.medicalConditions,
          medications: p.medications,
          emergencyNotes: p.emergencyNotes,
          hasPhoto: p.hasPhoto,
          enabled: p.enabled,
          updatedAt: p.updatedAt.toISOString(),
        }
      : null,
    emergencyContacts: src.contacts.map((c) => ({
      name: c.name,
      relationship: c.relationship,
      phone: c.phone,
      alternatePhone: c.alternatePhone,
      priority: c.priority,
    })),
    privacySettings: visibility,
    warranties: src.warranties.map((w) => ({
      helmetCode: w.helmetCode,
      status: w.status,
      purchaseDate: day(w.purchaseDate),
      startDate: day(w.startDate),
      endDate: day(w.endDate),
      sellerName: w.isRegistrant ? w.sellerName : null,
      invoiceNumber: w.isRegistrant ? w.invoiceNumber : null,
    })),
    securityEvents: src.events.map((e) => ({
      type: e.type,
      device: e.userAgentSummary,
      at: e.createdAt.toISOString(),
    })),
    deletionRequests: src.deletionRequests,
  };
}
