import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  Permission,
  type PrintArtworkFileDto,
  type PrintDesignDto,
  unitsPerSheet,
} from '@helmet/types';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { PrintService } from '../print/print.service';
import {
  CreatePrintDesignDto,
  PrintDesignListQueryDto,
  UpdatePrintDesignDto,
  UploadArtworkDto,
} from './dto/print-design.dto';
import { type UploadedFile as ArtworkUpload, PrintDesignsService } from './print-designs.service';

/** Hard transport cap; the configured per-format limits (SVG 5 MB, PNG 15 MB) apply after. */
const UPLOAD_HARD_LIMIT = 52 * 1024 * 1024;

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

@ApiTags('admin / print designs')
@Controller('admin/print-designs')
export class PrintDesignsController {
  constructor(
    private readonly designs: PrintDesignsService,
    private readonly print: PrintService,
  ) {}

  @Get()
  @AdminAuth(Permission.PRINT_DESIGN_VIEW)
  list(@Query() q: PrintDesignListQueryDto): Promise<PrintDesignDto[]> {
    return this.designs.list(q.status);
  }

  @Get('active')
  @AdminAuth(Permission.PRINT_DESIGN_VIEW)
  async active(): Promise<{ design: PrintDesignDto | null }> {
    return { design: await this.designs.active() };
  }

  @Post('artwork')
  @AdminAuth(Permission.PRINT_DESIGN_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_HARD_LIMIT, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        role: { type: 'string', enum: ['base', 'cover'] },
        testOnly: { type: 'string', enum: ['true', 'false'] },
      },
    },
  })
  @ApiOperation({
    summary:
      'Upload SVG/PNG artwork. Inspected server-side; SVG sanitized (strict whitelist); stored privately under print-designs/. Audited.',
  })
  upload(
    @UploadedFile() file: ArtworkUpload | undefined,
    @Body() dto: UploadArtworkDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<PrintArtworkFileDto> {
    return this.designs.uploadArtwork(file, dto.role, dto.testOnly === 'true', admin, meta);
  }

  @Post()
  @AdminAuth(Permission.PRINT_DESIGN_MANAGE)
  create(
    @Body() dto: CreatePrintDesignDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<PrintDesignDto> {
    return this.designs.create(dto, admin, meta);
  }

  @Get(':id')
  @AdminAuth(Permission.PRINT_DESIGN_VIEW)
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<PrintDesignDto> {
    return this.designs.get(id);
  }

  @Patch(':id')
  @AdminAuth(Permission.PRINT_DESIGN_MANAGE)
  @ApiOperation({ summary: 'Edit an unused DRAFT only; otherwise create a new version.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePrintDesignDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<PrintDesignDto> {
    return this.designs.update(id, dto, admin, meta);
  }

  @Post(':id/new-version')
  @AdminAuth(Permission.PRINT_DESIGN_MANAGE)
  newVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePrintDesignDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<PrintDesignDto> {
    return this.designs.newVersion(id, dto, admin, meta);
  }

  @Post(':id/duplicate')
  @AdminAuth(Permission.PRINT_DESIGN_MANAGE)
  duplicate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<PrintDesignDto> {
    return this.designs.duplicate(id, admin, meta);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.PRINT_DESIGN_ACTIVATE)
  @ApiOperation({ summary: 'Validate and make the default for future batches. Audited.' })
  activate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<PrintDesignDto> {
    return this.designs.activate(id, admin, meta);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.PRINT_DESIGN_MANAGE)
  archive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<PrintDesignDto> {
    return this.designs.archive(id, admin, meta);
  }

  @Delete(':id')
  @AdminAuth(Permission.PRINT_DESIGN_MANAGE)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ deleted: true }> {
    await this.designs.remove(id, admin, meta);
    return { deleted: true };
  }

  @Get(':id/preview/:kind.svg')
  @AdminAuth(Permission.PRINT_DESIGN_VIEW)
  @RawResponse()
  @ApiProduces('image/svg+xml')
  @ApiOperation({
    summary:
      'Sample-data preview from the production layout engine. scalePercent/offsetXMm/offsetYMm preview unsaved positions; guides=1 shows the safe-zone overlay.',
  })
  async preview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('kind') kind: string,
    @Query() q: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const layout = this.print.resolveLayout(q);
    const k = kind === 'sheet' ? 'sheet' : 'unit';
    const filled = num(q.filled);
    const svg = await this.designs.previewSvg(id, k, layout, {
      guides: q.guides === '1',
      position: {
        scalePercent: num(q.scalePercent),
        offsetXMm: num(q.offsetXMm),
        offsetYMm: num(q.offsetYMm),
      },
      filled:
        filled !== undefined && Number.isInteger(filled)
          ? Math.max(0, Math.min(unitsPerSheet(layout), filled))
          : undefined,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    res.type('image/svg+xml').send(svg);
  }

  @Get(':id/test-print.pdf')
  @AdminAuth(Permission.PRINT_DESIGN_VIEW)
  @RawResponse()
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'One production-size sheet of sample units marked TEST PRINT (no real PIN). Audited.',
  })
  testPrint(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: Record<string, string>,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
    @Res() res: Response,
  ): Promise<void> {
    return this.designs.streamTestPrint(id, this.print.resolveLayout(q), admin, meta, res);
  }
}
