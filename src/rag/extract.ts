// File → plain text. v1 scope per PRD M2: pdf, docx, md/txt. Unsupported files are
// reported, never silently dropped (data audit requirement).
import fs from "fs";
import path from "path";

export const SUPPORTED = [".md", ".markdown", ".txt", ".pdf", ".docx"];

export interface Extracted {
  text: string;
  title: string;
}

export async function extractText(filePath: string): Promise<Extracted> {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
    const text = fs.readFileSync(filePath, "utf8");
    const heading = text.match(/^#\s+(.+)$/m);
    return { text, title: heading?.[1]?.trim() ?? base };
  }
  if (ext === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
    try {
      const result = await parser.getText();
      return { text: result.text, title: base };
    } finally {
      await parser.destroy();
    }
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return { text: result.value, title: base };
  }
  throw new Error(`Unsupported file type: ${ext}`);
}
