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
    // Keep the original bytes: pdf-parse (pdfjs) detaches the array it's given,
    // so OCR needs its own fresh copy.
    const bytes = fs.readFileSync(filePath);
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    let text: string;
    let pages: number;
    try {
      const result = await parser.getText();
      text = result.text;
      pages = result.total ?? result.pages?.length ?? 1;
    } finally {
      await parser.destroy();
    }
    // Scanned PDF: little/no text layer. Fall back to OCR (ADR-007).
    if (text.trim().length / Math.max(pages, 1) < 100) {
      const { ocrPdf } = await import("./ocr.js");
      const ocr = await ocrPdf(new Uint8Array(bytes));
      if (ocr.text.trim().length > text.trim().length) {
        console.log(`  OCR fallback: ${ocr.pagesOcrd}/${ocr.pagesTotal} pages transcribed`);
        return { text: ocr.text, title: base };
      }
    }
    return { text, title: base };
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return { text: result.value, title: base };
  }
  throw new Error(`Unsupported file type: ${ext}`);
}
