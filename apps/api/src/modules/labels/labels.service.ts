import { Injectable } from '@nestjs/common';
import * as bwipjs from 'bwip-js';
import * as QRCode from 'qrcode';

/**
 * Label rendering. QR codes use error-correction level Q (~25% damage tolerance) because
 * helmet labels get scratched; barcodes are Code128 carrying only the helmet code.
 */
@Injectable()
export class LabelsService {
  qrSvg(url: string): Promise<string> {
    return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 });
  }

  qrPng(url: string, width = 512): Promise<Buffer> {
    return QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'Q', margin: 2, width });
  }

  barcodeSvg(helmetCode: string): string {
    return bwipjs.toSVG(this.barcodeOptions(helmetCode));
  }

  barcodePng(helmetCode: string): Promise<Buffer> {
    return bwipjs.toBuffer(this.barcodeOptions(helmetCode));
  }

  /** 10-module quiet zones and an opaque white background so printed labels scan reliably. */
  private barcodeOptions(text: string): bwipjs.RenderOptions {
    return {
      bcid: 'code128',
      text,
      scale: 3,
      height: 12,
      includetext: true,
      textxalign: 'center',
      textyoffset: -3,
      paddingwidth: 10,
      paddingheight: 4,
      backgroundcolor: 'FFFFFF',
    };
  }
}
