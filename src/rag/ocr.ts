// OCR fallback for scanned PDFs (ADR-007): rasterize pages with mupdf (WASM) and
// transcribe each with Claude vision on Haiku 4.5. Used by extract.ts only when
// the text layer is too sparse to be a real text PDF.
import type Anthropic from "@anthropic-ai/sdk";
import { client, withDeadline } from "../llm.js";

const OCR_MODEL = "claude-haiku-4-5";
const DPI = 150;
const MAX_PAGES = Number(process.env.OCR_MAX_PAGES ?? 30);

const TRANSCRIBE =
  "Transcribe all text in this document page exactly as written, preserving " +
  "headings, lists, and table structure as plain text. Output only the transcription, " +
  "no commentary. If the page has no readable text, output nothing.";

// Render one PDF page to a PNG buffer at DPI.
async function pageToPng(mupdf: any, doc: any, i: number): Promise<Buffer> {
  const page = doc.loadPage(i);
  const mtx = mupdf.Matrix.scale(DPI / 72, DPI / 72);
  const pix = page.toPixmap(mtx, mupdf.ColorSpace.DeviceRGB, false, true);
  return Buffer.from(pix.asPNG());
}

async function transcribe(png: Buffer): Promise<string> {
  const message = await withDeadline("ocr-page", (signal) =>
    client.messages.create(
      {
        model: OCR_MODEL,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
              },
              { type: "text", text: TRANSCRIBE },
            ],
          },
        ],
      },
      { signal }
    )
  );
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export interface OcrResult {
  text: string;
  pagesOcrd: number;
  pagesTotal: number;
  truncated: boolean;
}

export async function ocrPdf(data: Uint8Array): Promise<OcrResult> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  const pagesTotal = doc.countPages();
  const limit = Math.min(pagesTotal, MAX_PAGES);
  const parts: string[] = [];
  for (let i = 0; i < limit; i++) {
    const png = await pageToPng(mupdf, doc, i);
    const text = (await transcribe(png)).trim();
    if (text) parts.push(`[page ${i + 1}]\n${text}`);
  }
  const truncated = pagesTotal > limit;
  if (truncated) {
    console.warn(`  OCR: transcribed ${limit}/${pagesTotal} pages (OCR_MAX_PAGES=${MAX_PAGES})`);
  }
  return { text: parts.join("\n\n"), pagesOcrd: limit, pagesTotal, truncated };
}
