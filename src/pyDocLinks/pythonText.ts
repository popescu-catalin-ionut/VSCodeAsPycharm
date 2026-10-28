// Where the strings and comments are in Python source. Links are only made inside them (as the JetBrains plugin
// does with string literals and line comments), and symbol definitions are never looked for inside them.

export interface TextRegion {
  start: number;
  /** Exclusive. */
  end: number;
  kind: 'string' | 'comment';
}

export function pythonTextRegions(text: string): TextRegion[] {
  const regions: TextRegion[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') {
      const newline = text.indexOf('\n', i);
      const end = newline < 0 ? text.length : newline;
      regions.push({ start: i, end, kind: 'comment' });
      i = end;
    } else if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      let j = i + quote.length;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2; // an escaped character, quote or newline (also in raw strings, for tokenizing)
        } else if (!triple && text[j] === '\n') {
          break; // an unclosed one-line string ends with its line
        } else if (text.startsWith(quote, j)) {
          j += quote.length;
          break;
        } else {
          j++;
        }
      }
      const end = Math.min(j, text.length);
      regions.push({ start: i, end, kind: 'string' });
      i = end;
    } else {
      i++;
    }
  }
  return regions;
}

/** The region that holds both offsets, if any (binary search; regions are sorted and do not overlap). */
export function regionAround(regions: TextRegion[], start: number, end: number = start): TextRegion | undefined {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = regions[mid];
    if (start < r.start) {
      hi = mid - 1;
    } else if (start >= r.end) {
      lo = mid + 1;
    } else {
      return end <= r.end ? r : undefined;
    }
  }
  return undefined;
}
