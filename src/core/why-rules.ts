/**
 * Tunable knobs for the why-acceptance predicate. Defaults are the rollout
 * starting point; teams can soften via action inputs once we have signal on
 * false-positive rates from real PRs.
 */
export interface WhyRulesConfig {
  minRemarksWords: number;
  whyKeywords: string[];
}

export const DEFAULT_WHY_KEYWORDS: readonly string[] = [
  "because",
  "so that",
  "to ensure",
  "must",
  "cannot",
  "requires",
  "avoid",
  "prevent",
  "invariant",
  "otherwise",
];

export const DEFAULT_WHY_RULES_CONFIG: WhyRulesConfig = {
  minRemarksWords: 15,
  whyKeywords: [...DEFAULT_WHY_KEYWORDS],
};

export type WhyCheck = { ok: true } | { ok: false; reason: string };

export type WhyStatus = "ok" | "weak" | "missing";

const BOILERPLATE_PATTERNS: readonly RegExp[] = [
  /^this (function|method|class)\b/i,
  /^returns? /i,
  /^see (above|below)\b/i,
  /^(TODO|FIXME)\b/i,
];

const NUMBER_WITH_UNIT = /\b\d+(?:\.\d+)?\s?(?:ms|s|m|h|d|kb|mb|gb|tb|b|%)\b/i;
const TSDOC_INLINE_LINK = /\{@link\s+[^}]+\}/g;

/**
 * Decides whether a `@remarks` body is "why-shaped" enough to satisfy the
 * acceptance predicate.
 *
 * @remarks
 * Rule-based and deterministic — same input always produces the same result.
 * The AI variant authors candidate text, but this predicate is the only gate
 * that decides pass/fail, so the check cannot flap between runs on identical
 * code. Failure reasons are phrased to point the author at the specific clause
 * that failed, so a manual fix is cheap.
 *
 * @param remarksText - The body of the symbol's `@remarks` tag, or `undefined`
 *   when the tag is absent.
 * @param cfg - Word-count threshold and causal-keyword list. Defaults to
 *   {@link DEFAULT_WHY_RULES_CONFIG}.
 * @returns `{ ok: true }` when the remarks satisfy the predicate, otherwise
 *   `{ ok: false, reason }` with a human-readable explanation.
 */
export function hasAcceptableRemarks(
  remarksText: string | undefined,
  cfg: WhyRulesConfig = DEFAULT_WHY_RULES_CONFIG,
): WhyCheck {
  if (!remarksText || !remarksText.trim()) {
    return { ok: false, reason: "missing @remarks block" };
  }

  const trimmed = remarksText.trim();

  for (const p of BOILERPLATE_PATTERNS) {
    if (p.test(trimmed)) {
      return {
        ok: false,
        reason:
          "@remarks reads as boilerplate — explain *why* the constraint exists, not *what* the code does",
      };
    }
  }

  // Strip inline {@link ...} fragments before counting words so a remarks
  // block that's mostly cross-references doesn't game the threshold.
  const forCounting = trimmed.replace(TSDOC_INLINE_LINK, " ");
  const wordCount = (forCounting.match(/\b\w[\w'-]*\b/g) ?? []).length;
  if (wordCount < cfg.minRemarksWords) {
    return {
      ok: false,
      reason: `@remarks is ${wordCount} word(s), need ${cfg.minRemarksWords}`,
    };
  }

  const hasKeyword = cfg.whyKeywords.some((k) =>
    new RegExp(`\\b${escapeRegex(k)}\\b`, "i").test(trimmed),
  );
  const hasUnit = NUMBER_WITH_UNIT.test(trimmed);
  const hasLink = TSDOC_INLINE_LINK.test(trimmed);
  // Reset lastIndex — TSDOC_INLINE_LINK has the /g flag so .test() is stateful.
  TSDOC_INLINE_LINK.lastIndex = 0;

  if (!hasKeyword && !hasUnit && !hasLink) {
    return {
      ok: false,
      reason:
        "@remarks lacks a why-signal: include a causal keyword (because/so that/must/etc), a number with a unit (200ms, 4 KB), or a {@link} reference",
    };
  }

  return { ok: true };
}

/**
 * Maps a {@link WhyCheck} plus presence-of-text into the tri-state status
 * the rest of the pipeline carries on each {@link Violation}.
 */
export function classifyWhy(remarksText: string | undefined): {
  status: WhyStatus;
  reason?: string;
} {
  if (!remarksText || !remarksText.trim()) {
    return { status: "missing", reason: "missing @remarks block" };
  }
  const check = hasAcceptableRemarks(remarksText);
  if (check.ok) return { status: "ok" };
  return { status: "weak", reason: check.reason };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
