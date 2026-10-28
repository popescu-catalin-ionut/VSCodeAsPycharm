// Picks among several files with the same name (e.g. many main.py in a monorepo).
// From rufatpro/plugins jetbrains/py-doc-links (MIT), FileResolvePriority.kt; plus: a candidate whose path ends with
// the folders the reference names (pkg/a/main.py, or pkg.module -> pkg/module.py) beats all others.
import * as path from 'path';

const DEPRIORITIZED_SEGMENTS = ['/docs/', '/!to_tg/', '/examples/'];

const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) {
    i++;
  }
  return i;
}

/**
 * Higher is better: same folder as the source file, then below it, then a longer shared path and fewer hops;
 * docs/, !to_tg/ and examples/ copies lose points.
 */
export function scoreCandidate(sourceFile: string, candidate: string, wantedSuffix?: string): number {
  const anchor = normalize(path.dirname(sourceFile));
  const file = normalize(candidate);
  const dir = normalize(path.dirname(candidate));

  let score = 0;
  if (wantedSuffix && (file === normalize(wantedSuffix) || file.endsWith('/' + normalize(wantedSuffix).replace(/^(\.\.?\/)+/, '')))) {
    score += 100_000;
  }
  if (dir === anchor) {
    score += 10_000;
  }
  if (file.startsWith(anchor + '/')) {
    score += 1_000;
  }
  for (const segment of DEPRIORITIZED_SEGMENTS) {
    if (file.includes(segment)) {
      score -= 2_000;
    }
  }
  score += commonPrefixLength(anchor, dir);
  const hops = path.relative(path.dirname(sourceFile), path.dirname(candidate))
    .split(/[/\\]/)
    .filter((part) => part && part !== '.' && part !== '..').length;
  score -= hops * 50;
  return score;
}

/** Candidates, best first (stable for equal scores). */
export function rankCandidates(sourceFile: string, candidates: string[], wantedSuffix?: string): string[] {
  return candidates
    .map((c, i) => ({ c, i, s: scoreCandidate(sourceFile, c, wantedSuffix) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}
