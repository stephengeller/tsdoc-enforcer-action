/**
 * Word-count threshold below which a reply is considered "thin" and the
 * bot's commit-ack should include a gentle nudge to elaborate.
 *
 * @remarks
 * Tuned at 10 to match the spec's junior-friendly posture — shorter than a
 * sentence is usually too thin to carry real motivation, but anything longer
 * deserves the benefit of the doubt. Exported so a future PR can tune it
 * without re-editing the ack path.
 */
export const THIN_REPLY_WORD_THRESHOLD = 10;

/**
 * Returns `true` when the author's reply is too brief to have likely
 * captured real motivation.
 *
 * @remarks
 * Strips `{@link ...}` fragments and markdown markers (`*`, `_`, backticks,
 * headings) before counting so a reply padded with formatting isn't graded
 * as long. Whitespace-separated tokens are the unit because we don't need
 * linguistic precision — this only decides which of two ack strings to post.
 *
 * @param body - The raw reply body from the review comment. Safe to pass
 *   undefined / empty; both return `true`.
 */
export function isReplyThin(body: string | undefined): boolean {
  if (!body) return true;
  const stripped = body
    .replace(/\{@link[^}]*\}/g, "")
    .replace(/[*_`#>~]/g, "")
    .trim();
  if (stripped.length === 0) return true;
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length < THIN_REPLY_WORD_THRESHOLD;
}
