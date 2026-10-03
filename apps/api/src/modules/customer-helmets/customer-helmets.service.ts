import { Injectable } from '@nestjs/common';
import {
  type CustomerDashboardDto,
  type CustomerHelmetDto,
  ErrorCode,
  type HelmetStatus,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EmergencyReadinessService } from '../emergency-readiness/emergency-readiness.service';
import { helmetProfileStatus, profileStatus } from '../emergency-readiness/readiness';

interface OwnedHelmetRow {
  activatedAt: Date;
  helmet: {
    id: string;
    helmetCode: string;
    serialNumber: string;
    status: HelmetStatus;
    activatedAt: Date | null;
    publicToken: string;
    helmetModel: { name: string; brand: string };
  };
}

const ownedSelect = {
  activatedAt: true,
  helmet: {
    select: {
      id: true,
      helmetCode: true,
      serialNumber: true,
      status: true,
      activatedAt: true,
      publicToken: true,
      helmetModel: { select: { name: true, brand: true } },
    },
  },
} as const;

/**
 * Helmets owned by the authenticated customer. Ownership comes only from an ACTIVE
 * helmet_ownerships row; a helmet the customer doesn't own is indistinguishable from a missing one.
 */
@Injectable()
export class CustomerHelmetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: EmergencyReadinessService,
    private readonly config: AppConfigService,
  ) {}

  async list(userId: string): Promise<CustomerHelmetDto[]> {
    const [rows, facts] = await Promise.all([
      this.prisma.helmetOwnership.findMany({
        where: { userId, status: 'ACTIVE' },
        orderBy: { activatedAt: 'desc' },
        select: ownedSelect,
      }),
      this.readiness.facts(userId),
    ]);
    const ownerStatus = profileStatus(facts);
    return rows.map((row) => this.toDto(row, ownerStatus));
  }

  async get(userId: string, helmetId: string): Promise<CustomerHelmetDto> {
    const row = await this.findOwned(userId, helmetId);
    return this.toDto(row, profileStatus(await this.readiness.facts(userId)));
  }

  /** Public QR URL for one of the customer's own helmets (used for the QR preview). */
  async publicUrl(userId: string, helmetId: string): Promise<string> {
    return this.config.publicHelmetUrl((await this.findOwned(userId, helmetId)).helmet.publicToken);
  }

  async dashboard(userId: string): Promise<CustomerDashboardDto> {
    const [helmets, readiness, contactCount] = await Promise.all([
      this.list(userId),
      this.readiness.readiness(userId),
      this.prisma.emergencyContact.count({ where: { userId, isActive: true } }),
    ]);
    return { helmets, readiness, contactCount };
  }

  private async findOwned(userId: string, helmetId: string): Promise<OwnedHelmetRow> {
    const row = await this.prisma.helmetOwnership.findFirst({
      where: { userId, helmetId, status: 'ACTIVE' },
      select: ownedSelect,
    });
    if (!row) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
    return row;
  }

  private toDto(
    row: OwnedHelmetRow,
    ownerStatus: ReturnType<typeof profileStatus>,
  ): CustomerHelmetDto {
    const h = row.helmet;
    return {
      id: h.id,
      helmetCode: h.helmetCode,
      serialNumber: h.serialNumber,
      status: h.status,
      model: h.helmetModel,
      activatedAt: h.activatedAt?.toISOString() ?? null,
      ownedSince: row.activatedAt.toISOString(),
      publicUrl: this.config.publicHelmetUrl(h.publicToken),
      emergencyProfileStatus: helmetProfileStatus(ownerStatus, h.status),
    };
  }
}
