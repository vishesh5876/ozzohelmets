declare module 'svg-to-pdfkit' {
  interface SvgToPdfOptions {
    width?: number;
    height?: number;
    preserveAspectRatio?: string;
    useCSS?: boolean;
    assumePt?: boolean;
    fontCallback?: (family: string, bold: boolean, italic: boolean, options: object) => string;
    imageCallback?: (link: string) => unknown;
    documentCallback?: (file: string) => unknown;
    warningCallback?: (warning: string) => void;
  }
  function SVGtoPDF(
    doc: PDFKit.PDFDocument,
    svg: string,
    x?: number,
    y?: number,
    options?: SvgToPdfOptions,
  ): void;
  export = SVGtoPDF;
}
