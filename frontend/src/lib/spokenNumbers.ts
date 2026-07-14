// Display-side number annotation: Levi SPEAKS numbers as words (bare digits
// stutter in TTS), but a transcript full of "two hundred eighty eight
// thousand dollars" reads slowly. The speech channel and the transcript are
// the same text, so the numerals are reconstructed here, display-only:
//   "two hundred eighty eight thousand dollars" -> ... dollars ($288,000)
//   "forty eight thirty four Ute Street"        -> ... four (4834) Ute Street
//   "three two eight one nine"                  -> ... nine (32819)
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };

const isNumWord = (w: string) => w in UNITS || w in TENS || w in SCALES;

// Parse a run of number words into "groups": a new group starts when a word
// can't extend the current one (e.g. "forty eight thirty four" -> [48, 34]).
function parseGroups(words: string[]): { groups: number[]; hasScale: boolean } {
  const groups: number[] = [];
  let cur = 0; // sub-thousand accumulator
  let acc = 0; // scale accumulator (thousands and up)
  let hasScale = false;
  let started = false;
  const flush = () => {
    if (started) groups.push(acc + cur);
    cur = 0;
    acc = 0;
    started = false;
  };
  for (const w of words) {
    if (w in SCALES) {
      hasScale = true;
      if (SCALES[w] === 100) cur = (cur || 1) * 100;
      else {
        acc += (cur || 1) * SCALES[w];
        cur = 0;
      }
      started = true;
    } else if (w in TENS) {
      if (started && cur % 100 !== 0) flush(); // "forty eight" then "thirty" -> new group
      cur += TENS[w];
      started = true;
    } else {
      const v = UNITS[w];
      const lastTwo = cur % 100;
      if (!started) cur = v;
      else if (lastTwo === 0 && (cur > 0 || acc > 0)) cur += v; // "two hundred" + "six"
      else if (lastTwo >= 20 && lastTwo % 10 === 0 && v >= 1 && v <= 9) cur += v; // "forty" + "eight"
      else {
        flush();
        cur = v;
      }
      started = true;
    }
  }
  flush();
  return { groups, hasScale };
}

function formatRun(words: string[], followedByDollars: boolean): string | null {
  const { groups, hasScale } = parseGroups(words);
  if (!groups.length) return null;
  // Digit sequence ("three two eight one nine"): 3+ single digits, concatenated.
  if (!hasScale && groups.length >= 3 && groups.every((g) => g >= 0 && g <= 9)) {
    return groups.join("");
  }
  // Spoken house number / year ("forty eight thirty four" -> 4834).
  if (!hasScale && groups.length === 2 && groups.every((g) => g >= 10 && g <= 99)) {
    return `${groups[0]}${String(groups[1]).padStart(2, "0")}`;
  }
  if (groups.length !== 1) return null; // ambiguous — skip rather than mislabel
  const v = groups[0];
  // Small counts ("three emails") don't need annotation; money >= 100 does.
  if (v < 1000 && !(followedByDollars && v >= 100)) return null;
  const num = v.toLocaleString("en-US");
  return followedByDollars ? `$${num}` : num;
}

// Scan text for runs of number words and append the numeric form after the
// run (after "dollars"/"dollar" when present). Display-only transformation.
export function annotateNumbers(text: string): string {
  const tokens = text.split(/(\s+|[^\sA-Za-z]+)/); // words + separators, preserved
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]+$/.test(t) && isNumWord(t.toLowerCase())) {
      // collect the run: number words separated by single whitespace
      const runWords: string[] = [t.toLowerCase()];
      const runTokens: string[] = [t];
      let j = i + 1;
      while (j + 1 < tokens.length && /^\s+$/.test(tokens[j]) && /^[A-Za-z]+$/.test(tokens[j + 1]) && isNumWord(tokens[j + 1].toLowerCase())) {
        runTokens.push(tokens[j], tokens[j + 1]);
        runWords.push(tokens[j + 1].toLowerCase());
        j += 2;
      }
      // optional "dollars"/"dollar" right after
      let dollars = false;
      let dollarTokens: string[] = [];
      if (j + 1 < tokens.length && /^\s+$/.test(tokens[j]) && /^dollars?$/i.test(tokens[j + 1])) {
        dollars = true;
        dollarTokens = [tokens[j], tokens[j + 1]];
        j += 2;
      }
      const anno = runWords.length >= 2 || dollars ? formatRun(runWords, dollars) : null;
      out.push(...runTokens, ...dollarTokens);
      if (anno) out.push(` (${anno})`);
      i = j;
    } else {
      out.push(t);
      i++;
    }
  }
  return out.join("");
}
