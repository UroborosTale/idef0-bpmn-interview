declare module "pdf-parse" {
  interface PDFParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdfParse(data: Buffer, options?: Record<string, unknown>): Promise<PDFParseResult>;
  export default pdfParse;
}
