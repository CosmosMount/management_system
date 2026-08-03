import {
  compactSearchText,
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";
import { getPinyinInitials } from "@/lib/search/pinyin-initials";

export type FuzzySearchField = {
  text: string;
  weight?: number;
  pinyin?: boolean;
};

const SCORE_SCALE = 1_000_000;

function tierScore(
  tier: number,
  start: number,
  gaps: number,
  lengthDelta: number,
): number {
  return tier * SCORE_SCALE - start * 100 - gaps * 10 - lengthDelta;
}

function subsequenceMetrics(target: string, query: string) {
  let targetIndex = 0;
  let firstIndex = -1;
  let previousIndex = -1;
  let gaps = 0;
  for (const character of query) {
    const found = target.indexOf(character, targetIndex);
    if (found === -1) return null;
    if (firstIndex === -1) firstIndex = found;
    if (previousIndex >= 0) gaps += found - previousIndex - 1;
    previousIndex = found;
    targetIndex = found + 1;
  }
  return { start: firstIndex, gaps };
}

function scoreTerm(field: FuzzySearchField, rawTerm: string): number | null {
  const normalized = normalizeSearchText(field.text);
  const compact = compactSearchText(field.text);
  const term = compactSearchText(rawTerm);
  if (!term || !compact) return null;
  const lengthDelta = Math.max(0, compact.length - term.length);
  let score: number | null = null;

  if (compact === term) {
    score = tierScore(600, 0, 0, 0);
  } else if (compact.startsWith(term)) {
    score = tierScore(500, 0, 0, lengthDelta);
  } else {
    const words = normalized.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
    const wordIndex = words.findIndex((word) => word.startsWith(term));
    if (wordIndex >= 0) {
      score = tierScore(400, wordIndex, 0, lengthDelta);
    } else {
      const substringIndex = compact.indexOf(term);
      if (substringIndex >= 0) {
        score = tierScore(300, substringIndex, 0, lengthDelta);
      }
    }
  }

  const initials = field.pinyin ? getPinyinInitials(field.text) : "";
  if (initials) {
    const initialsIndex = initials.indexOf(term);
    if (initialsIndex >= 0) {
      score = Math.max(
        score ?? Number.NEGATIVE_INFINITY,
        tierScore(200, initialsIndex, 0, Math.max(0, initials.length - term.length)),
      );
    }
  }

  const compactSubsequence = subsequenceMetrics(compact, term);
  const initialsSubsequence = initials
    ? subsequenceMetrics(initials, term)
    : null;
  for (const metrics of [compactSubsequence, initialsSubsequence]) {
    if (!metrics) continue;
    score = Math.max(
      score ?? Number.NEGATIVE_INFINITY,
      tierScore(100, metrics.start, metrics.gaps, lengthDelta),
    );
  }

  if (score === null || !Number.isFinite(score)) return null;
  return score + (field.weight ?? 0) * 10_000;
}

export function fuzzyScore(
  fields: readonly FuzzySearchField[],
  rawQuery: string,
): number | null {
  const terms = searchTerms(rawQuery);
  if (terms.length === 0) return 0;
  let total = 0;
  for (const term of terms) {
    let best: number | null = null;
    for (const field of fields) {
      const score = scoreTerm(field, term);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

export function rankFuzzyMatches<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly FuzzySearchField[],
  tieBreak: (left: T, right: T) => number,
): Array<{ item: T; score: number }> {
  return items
    .flatMap((item) => {
      const score = fuzzyScore(fields(item), query);
      return score === null ? [] : [{ item, score }];
    })
    .sort((left, right) => right.score - left.score || tieBreak(left.item, right.item));
}
