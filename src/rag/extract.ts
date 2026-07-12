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
    let perPage: string[];
    try {
      const result = await parser.getText();
      perPage = (result.pages ?? []).map((p: { text?: string }) => p.text ?? "");
      if (perPage.length === 0) perPage = [result.text ?? ""];
    } finally {
      await parser.destroy();
    }

    // Per-page fallback (ADR-007): OCR only the pages whose text layer is empty
    // — real contracts are mixed (e-signed text pages + scanned image pages), so
    // a document-level average would skip the scans that carry the actual terms.
    const PAGE_TEXT_MIN = 40;
    // A text layer can be present but corrupt: some e-sign PDFs ship broken
    // font maps that drop whole glyphs (observed live: every lowercase "n"
    // extracted as a newline, so "Contract" was indexed as "Co<nl>tract").
    // English prose is ~6-7% "n"; near-zero across a full page means the
    // layer is unusable — treat the page like a scan and OCR it.
    const corruptTextLayer = (t: string): boolean => {
      const letters = (t.match(/[a-z]/g) ?? []).length;
      if (letters < 200) return false;
      const ns = (t.match(/n/g) ?? []).length;
      return ns / letters < 0.01;
    };
    const scanned = perPage
      .map((t, i) => (t.trim().length < PAGE_TEXT_MIN || corruptTextLayer(t) ? i : -1))
      .filter((i) => i >= 0);

    // Pages transcribed from scans get a legibility marker so answers can hedge
    // on hard-to-read pages instead of asserting OCR noise as fact.
    const lowConf = new Set<number>();
    if (scanned.length > 0) {
      const { ocrSelectedPages } = await import("./ocr.js");
      const ocr = await ocrSelectedPages(new Uint8Array(bytes), scanned);
      for (const [i, page] of ocr.byPage) {
        perPage[i] = page.text;
        if (page.legibility !== "clear") lowConf.add(i);
      }
      console.log(
        `  OCR: ${ocr.transcribed}/${scanned.length} scanned pages recovered ` +
          `(${lowConf.size} low-confidence) of ${perPage.length} total`
      );
    }

    // Label pages so citations can point at a page; drop empty ones.
    const text = perPage
      .map((t, i) => {
        if (!t.trim()) return "";
        const tag = lowConf.has(i)
          ? `[page ${i + 1} — scanned, OCR may contain errors in names/numbers]`
          : `[page ${i + 1}]`;
        return `${tag}\n${t.trim()}`;
      })
      .filter(Boolean)
      .join("\n\n");
    return { text, title: base };
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return { text: result.value, title: base };
  }
  throw new Error(`Unsupported file type: ${ext}`);
}
