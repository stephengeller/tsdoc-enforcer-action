import * as github from "@actions/github";
import * as core from "@actions/core";

import type { EnrichedViolation } from "./types";

/**
 * Posts a PR review containing one inline suggestion per violation.
 *
 * Each inline comment uses GitHub's ```suggestion fenced block so the
 * reviewer can one-click "Apply suggestion" to commit the TSDoc directly
 * above the symbol. The suggestion replaces the symbol's starting line
 * with `<indented-doc>\n<original-line>` — net effect is insertion.
 *
 * Individual inline-comment failures (e.g. line not in diff hunk) don't
 * abort the review — they fall back to a summary list in the review body
 * so the developer still has paste-ready doc blocks.
 */
export async function postReviewWithSuggestions(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  violations: EnrichedViolation[];
}): Promise<void> {
  const { token, owner, repo, prNumber, headSha, violations } = args;
  const octokit = github.getOctokit(token);

  const inlineComments = violations.map((v) => ({
    path: v.file,
    line: v.line,
    side: "RIGHT" as const,
    body: buildSuggestionBody(v),
  }));

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: "COMMENT",
      body: buildSummaryBody(violations),
      comments: inlineComments,
    });
    core.info(`Posted review with ${inlineComments.length} inline suggestions`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(
      `Review with inline suggestions failed (${message}); falling back to issue comment.`,
    );
    await postFallbackIssueComment(octokit, owner, repo, prNumber, violations);
  }
}

/**
 * Builds the body of a single inline review comment. Wraps the AI-generated
 * TSDoc plus the original line in a `suggestion` block that GitHub renders
 * with an "Apply suggestion" button.
 */
function buildSuggestionBody(v: EnrichedViolation): string {
  const indent = leadingWhitespace(v.originalLine);
  const indentedDoc = v.tsdoc
    .split("\n")
    .map((l) => (l.length === 0 ? "" : `${indent}${l}`))
    .join("\n");

  return [
    `**TSDoc missing for \`${v.symbolName}\`** (${v.kind}).`,
    "",
    "Either click **Apply suggestion** to use this generated block, or write your own — you know the intent of your code better than the model does. Either approach will satisfy the check.",
    "",
    "```suggestion",
    `${indentedDoc}\n${v.originalLine}`,
    "```",
  ].join("\n");
}

function buildSummaryBody(violations: EnrichedViolation[]): string {
  const list = violations
    .map(
      (v, i) =>
        `${i + 1}. <code>${v.file}:${v.line}</code> — <code>${v.symbolName}</code> (${v.kind})`,
    )
    .join("\n");

  return [
    `🚨 TSDoc missing for ${violations.length} symbol(s). For each inline comment below, either click **Apply suggestion** to use the generated TSDoc or write your own — either will satisfy the check.`,
    "",
    list,
  ].join("\n");
}

function leadingWhitespace(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : "";
}

/**
 * Fallback when createReview errors (e.g. all inline comments target lines
 * outside the diff hunk). Posts the same info as a plain issue comment so
 * the developer still sees the paste-ready doc blocks.
 */
async function postFallbackIssueComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  violations: EnrichedViolation[],
): Promise<void> {
  const sections = violations
    .map((v) =>
      [
        `### \`${v.file}:${v.line}\` — \`${v.symbolName}\` (${v.kind})`,
        "",
        "```typescript",
        v.tsdoc,
        "```",
      ].join("\n"),
    )
    .join("\n\n");

  const body = [
    "<!-- tsdoc-enforcer-fallback -->",
    `🚨 TSDoc missing for ${violations.length} symbol(s). Inline-suggestion posting failed — paste the blocks below manually.`,
    "",
    sections,
  ].join("\n");

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}
