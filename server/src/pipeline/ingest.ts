import mammoth from "mammoth";
// pdf-parse ships a debug entry point on default import in some bundlers; use dynamic import to keep it lazy.

export async function parseUploadedFile(filename: string, contentBase64: string): Promise<string> {
  const buf = Buffer.from(contentBase64, "base64");
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }
  if (lower.endsWith(".pdf")) {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buf);
    return result.text;
  }
  // txt / md / прочее — как есть в UTF-8
  return buf.toString("utf-8");
}
