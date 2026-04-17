/**
 * The default label that flips a why-violation from blocking to passing.
 * Documented in the README so reviewers and bots agree on the spelling.
 */
export const DEFAULT_BYPASS_LABEL = "why-acknowledged";

/**
 * Returns `true` when the PR carries the configured bypass label.
 *
 * @remarks
 * The bypass label is the soft-block escape hatch agreed with the user — it
 * lets a reviewer wave through a trivial PR without forcing the author to
 * author meaningless `@remarks` prose. Defaults to {@link DEFAULT_BYPASS_LABEL}
 * to keep behaviour predictable across repos that adopt the action without
 * configuring an input.
 *
 * Accepts `unknown` because `@actions/github`'s typed PR payload omits
 * `labels` even though the webhook runtime payload always carries it; we
 * narrow defensively so a missing or oddly-shaped `labels` field doesn't
 * crash the action.
 *
 * @param pr - The `pull_request` payload from `@actions/github` context.
 * @param labelName - Exact label string to look for. Comparison is
 *   case-sensitive because GitHub label names preserve case.
 * @returns `true` when at least one of the PR's labels matches.
 */
export function hasBypassLabel(pr: unknown, labelName: string): boolean {
  const labels = (pr as { labels?: unknown } | null | undefined)?.labels;
  if (!Array.isArray(labels) || labels.length === 0) return false;
  return labels.some((l) => {
    if (typeof l === "string") return l === labelName;
    if (l && typeof l === "object" && "name" in l) {
      return (l as { name?: unknown }).name === labelName;
    }
    return false;
  });
}
