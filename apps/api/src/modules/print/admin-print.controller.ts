import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permission, type SafetyIdPrintStatusDto, unitsPerSheet } from '@helmet/types';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { cutGuidePdf } from './pdf-renderer';
import { PrintService } from './print.service';

/**
 * Print engine status, sample previews and the cut guide. Nothing here contains a PIN: previews
 * use sample data, the cut guide has no artwork. PIN-bearing files are batch exports
 * (AdminSafetyIdBatchesController), which are audited.
 */
@ApiTags('admin / safety ID print')
@Controller('admin/safety-id-print')
export class AdminSafetyIdPrintController {
  constructor(private readonly print: PrintService) {}

  @Get('status')
  @AdminAuth(Permission.SAFETY_IDS_READ)
  @ApiOperation({ summary: 'Layout, derived sticker geometry and logo asset state.' })
  status(@Query() query: Record<string, string>): SafetyIdPrintStatusDto {
    return this.print.status(this.print.resolveLayout(query));
  }

  @Get('preview/unit.svg')
  @AdminAuth(Permission.SAFETY_IDS_READ)
  @RawResponse()
  @ApiProduces('image/svg+xml')
  unit(@Query() query: Record<string, string>, @Res() res: Response): void {
    const svg = this.print.previewUnitSvg(this.print.resolveLayout(query), query.proof === '1');
    this.svg(res, svg);
  }

  @Get('preview/sheet.svg')
  @AdminAuth(Permission.SAFETY_IDS_READ)
  @RawResponse()
  @ApiProduces('image/svg+xml')
  sheet(@Query() query: Record<string, string>, @Res() res: Response): void {
    const layout = this.print.resolveLayout(query);
    const per = unitsPerSheet(layout);
    const filled = query.filled === undefined ? per : Number(query.filled);
    const n = Number.isInteger(filled) ? Math.max(0, Math.min(per, filled)) : per;
    this.svg(res, this.print.previewSheetSvg(layout, n));
  }

  @Get('cut-guide.pdf')
  @AdminAuth(Permission.SAFETY_IDS_READ)
  @RawResponse()
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Die/cut guide for one sheet (ThroughCut + CutContour spot colours).' })
  cutGuide(@Query() query: Record<string, string>, @Res() res: Response): void {
    const layout = this.print.resolveLayout(query);
    const doc = cutGuidePdf(
      layout,
      this.print.geometry(layout),
      `Safety ID cut guide ${layout.sheetWidthIn}x${layout.sheetHeightIn} ${unitsPerSheet(layout)}-up`,
    );
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="safety-id-cut-guide-${layout.columns}x${layout.rows}.pdf"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    doc.pipe(res);
    doc.end();
  }

  private svg(res: Response, svg: string): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.type('image/svg+xml').send(svg);
  }
}
