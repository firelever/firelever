// Heading-aware chunking (ADR-002): split markdown/plain text into blocks, pack
// blocks into ~TARGET-char chunks, hard-split oversized blocks at sentence
// boundaries. Each chunk gets a "file › section" breadcrumb prepended so both
// retrievers see section context and citations have a readable anchor.
// Bump CHUNKER_VERSION on any change to chunking logic or knobs: it is folded
// into the ingest content hash so affected documents re-chunk automatically.
export const CHUNKER_VERSION = 3;
const TARGET = 700;
const MAX = 1100;

export interface Chunk {
  heading: string | null;
  text: string;
}

// Oversized blocks split at line boundaries first (list items stay intact); only a
// single line longer than MAX falls back to sentence splitting. The sentence regex
// requires whitespace after the punctuation so "Instantly.ai" or "v0.1.9" never split.
function splitUnits(block: string): string[] {
  const units: string[] = [];
  for (const line of block.split("\n")) {
    if (line.length <= 1100) {
      units.push(line);
    } else {
      units.push(...line.split(/(?<=[.!?])\s+/));
    }
  }
  return units;
}

export function chunkText(source: string, docName: string): Chunk[] {
  const blocks: { heading: string | null; text: string }[] = [];
  let currentHeading: string | null = null;

  for (const raw of source.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    const headingMatch = block.match(/^(#{1,6})\s+(.+)$/m);
    if (headingMatch) currentHeading = headingMatch[2].replace(/[*_`]/g, "").trim();
    if (block.length <= MAX) {
      blocks.push({ heading: currentHeading, text: block });
    } else {
      // Oversized block (long list, table, wall of text): pack line/sentence units.
      let piece = "";
      for (const u of splitUnits(block)) {
        if (piece.length + u.length > MAX && piece) {
          blocks.push({ heading: currentHeading, text: piece.trim() });
          piece = "";
        }
        piece += u + "\n";
      }
      if (piece.trim()) blocks.push({ heading: currentHeading, text: piece.trim() });
    }
  }

  // Pack consecutive same-ish blocks into chunks around TARGET chars.
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufHeading: string | null = null;
  let bufLen = 0;
  const flush = () => {
    if (!buf.length) return;
    const breadcrumb = bufHeading ? `${docName} › ${bufHeading}` : docName;
    chunks.push({ heading: bufHeading, text: `[${breadcrumb}]\n${buf.join("\n\n")}` });
    buf = [];
    bufLen = 0;
  };
  for (const b of blocks) {
    const headingChanged = buf.length > 0 && b.heading !== bufHeading;
    if (bufLen + b.text.length > TARGET || (headingChanged && bufLen > TARGET / 2)) flush();
    if (!buf.length) bufHeading = b.heading;
    buf.push(b.text);
    bufLen += b.text.length;
  }
  flush();
  return chunks;
}
