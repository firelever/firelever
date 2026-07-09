// OCR fallback for scanned PDFs (ADR-007, quality upgrade ADR-009): rasterize
// pages with mupdf (WASM) and transcribe with Claude vision. Each page returns a
// legibility flag so downstream answers can hedge on hard-to-read scans instead
// of asserting OCR artifacts as fact.
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { client, withDeadline } from "../llm.js";

// Opus 4.8 has high-resolution vision (up to 2576px long edge) — it can actually
// use the detail a higher DPI provides, where Haiku would downscale it away.
// Legal documents live or die on names/numbers, so accuracy beats the small cost.
const OCR_MODEL = process.env.OCR_MODEL ?? "claude-opus-4-8";
const DPI = Number(process.env.OCR_DPI ?? 220);
const MAX_PAGES = Number(process.env.OCR_MAX_PAGES ?? 30);

const TRANSCRIBE =
  "Transcribe this scanned document page exactly as written. Preserve headings, " +
  "lists, and table structure as plain text. Transcribe names, dollar amounts, " +
  "dates, and reference numbers character for character — do not normalize or guess " +
  "at them. If a character is genuinely unclear, give your best reading but reflect " +
  "the uncertainty in the legibility rating. Output only the transcription.";

const OcrSchema = z.object({
  text: z.string().describe("exact transcription; empty string if the page has no readable text"),
  legibility: z
    .enum(["clear", "partial", "poor"])
    .describe(
      "clear = confident throughout; partial = some words/numbers uncertain; poor = largely illegible"
    ),
});

export interface OcrPage {
  text: string;
  legibility: "clear" | "partial" | "poor";
}

function pageToPng(mupdf: any, doc: any, i: number): Buffer {
  const page = doc.loadPage(i);
  const mtx = mupdf.Matrix.scale(DPI / 72, DPI / 72);
  const pix = page.toPixmap(mtx, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    return Buffer.from(pix.asPNG());
  } finally {
    pix.destroy?.();
    page.destroy?.();
  }
}

async function transcribe(png: Buffer): Promise<OcrPage> {
  const response = await withDeadline("ocr-page", (signal) =>
    client.messages.parse(
      {
        model: OCR_MODEL,
        max_tokens: 8000,
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
        output_config: { format: zodOutputFormat(OcrSchema) },
      },
      { signal }
    )
  );
  return response.parsed_output ?? { text: "", legibility: "poor" };
}

export interface OcrPagesResult {
  byPage: Map<number, OcrPage>; // 0-based page index -> {text, legibility}
  requested: number;
  transcribed: number;
  skippedForCap: number;
}

export async function ocrSelectedPages(
  data: Uint8Array,
  pageIndices: number[]
): Promise<OcrPagesResult> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  const todo = pageIndices.slice(0, MAX_PAGES);
  const byPage = new Map<number, OcrPage>();
  try {
    for (const i of todo) {
      const png = pageToPng(mupdf, doc, i);
      const page = await transcribe(png);
      if (page.text.trim()) byPage.set(i, page);
    }
  } finally {
    doc.destroy?.();
  }
  const skippedForCap = pageIndices.length - todo.length;
  if (skippedForCap > 0) {
    console.warn(
      `  OCR: ${todo.length} scanned pages transcribed, ${skippedForCap} skipped (OCR_MAX_PAGES=${MAX_PAGES})`
    );
  }
  return { byPage, requested: pageIndices.length, transcribed: byPage.size, skippedForCap };
}
