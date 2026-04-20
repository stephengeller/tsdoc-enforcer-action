import * as github from "@actions/github";
import * as core from "@actions/core";

import type { Violation } from "../core/types";
import type { WhyDecision } from "./generate";

/**
 * Pairs a {@link Violation} with the AI's routing decision.
 *
 * @remarks
 * Carried as one struct (rather than two parallel arrays) so the review
 * layer can never accidentally mismatch indices between the violations
 * list and the decisions list — a class of bug that would post the wrong
 * symbol's TSDoc as a suggestion under another symbol's line.
 */
export interface DecidedViolation {
  violation: Violation;
  decision: WhyDecision;
}

/**
 * Posts a single PR review whose inline comments dispatch on the AI's
 * `WhyDecision` for each violation.
 *
 * @remarks
 * `suggest` decisions become inline comments with a GitHub
 * ```suggestion``` block so the author can one-click apply the generated
 * TSDoc. `ask` decisions become inline comments listing the questions the
 * author needs to answer in code (no `suggestion` block — there is no
 * draft to apply, only questions). `skip` decisions are not posted; they
 * appear only in the review summary as the AI's no-op stat.
 *
 * Inline-comment failures (e.g. line outside the diff hunk) cannot be
 * recovered selectively because `pulls.createReview` is all-or-nothing,
 * so on error we fall back to a single issue comment that lists the
 * suggestions and questions inline. This preserves the author's ability
 * to act on the AI output even when GitHub rejects the inline placement.
 */
export async function postReviewWithDecisions(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  decided: DecidedViolation[];
}): Promise<void> {
  const { token, owner, repo, prNumber, headSha, decided } = args;
  const octokit = github.getOctokit(token);

  const postable = decided.filter((d) => d.decision.action !== "skip");
  const skipped = decided.filter((d) => d.decision.action === "skip");

  const inlineComments = postable.map((d) => ({
    path: d.violation.file,
    line: d.violation.line,
    side: "RIGHT" as const,
    body: `${buildCommentBody(d)}\n\n${buildReplyMarker(d.violation)}`,
  }));

  if (inlineComments.length === 0) {
    core.info(
      `No inline comments to post — every violation was AI-skipped (${skipped.length}).`,
    );
    return;
  }

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: "COMMENT",
      body: buildSummaryBody(decided),
      comments: inlineComments,
    });
    core.info(
      `Posted review with ${inlineComments.length} inline comment(s) ` +
        `(${countByAction(decided, "suggest")} suggest, ` +
        `${countByAction(decided, "ask")} ask, ` +
        `${countByAction(decided, "skip")} skip).`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(
      `Review with inline comments failed (${message}); falling back to issue comment.`,
    );
    await postFallbackIssueComment(octokit, owner, repo, prNumber, decided);
  }
}

function buildCommentBody(d: DecidedViolation): string {
  if (d.decision.action === "suggest") return buildSuggestBody(d);
  if (d.decision.action === "ask") return buildAskBody(d);
  // `skip` is filtered out before this — the union check above is for type
  // narrowing only. Throwing keeps the discriminated union exhaustive.
  throw new Error(
    `buildCommentBody called for skip on ${d.violation.symbolName}`,
  );
}

function buildSuggestBody(d: DecidedViolation): string {
  if (d.decision.action !== "suggest") {
    throw new Error("buildSuggestBody requires suggest decision");
  }
  const indent = leadingWhitespace(d.violation.originalLine);
  const indentedDoc = d.decision.tsdocFull
    .split("\n")
    .map((l) => (l.length === 0 ? "" : `${indent}${l}`))
    .join("\n");

  const lines: string[] = [
    `💬 **Reply with the "why" for \`${d.violation.symbolName}\`** — I'll write the docs.`,
  ];

  const examples = d.decision.whyExamples;
  if (examples && examples.length > 0) {
    lines.push(
      "",
      '<details><summary>Examples of a good "why" reply</summary>',
      "",
      ...examples.map((ex) => `- *${ex}*`),
      "",
      "</details>",
    );
  }

  lines.push(
    "",
    "<details><summary>Or, use my draft</summary>",
    "",
    "```suggestion",
    `${indentedDoc}\n${d.violation.originalLine}`,
    "```",
    "",
    "</details>",
  );

  return lines.join("\n");
}

function buildAskBody(d: DecidedViolation): string {
  if (d.decision.action !== "ask") {
    throw new Error("buildAskBody requires ask decision");
  }

  const lines: string[] = [
    `💬 **Reply with the "why" for \`${d.violation.symbolName}\`** — I'll write the docs.`,
  ];

  const examples = d.decision.whyExamples;
  if (examples && examples.length > 0) {
    lines.push(
      "",
      '<details><summary>Examples of a good "why" reply</summary>',
      "",
      ...examples.map((ex) => `- *${ex}*`),
      "",
      "</details>",
    );
  }

  return lines.join("\n");
}

function buildSummaryBody(decided: DecidedViolation[]): string {
  const postable = decided.filter((d) => d.decision.action !== "skip");
  const n = postable.length;
  const lines = [
    `📝 **${n} symbol(s) need a quick "why".** Reply to each inline comment with a sentence on why the code exists — I'll write the docs for you.`,
  ];

  const skipped = decided.filter((d) => d.decision.action === "skip");
  if (skipped.length > 0) {
    lines.push(
      "",
      `_${skipped.length} symbol(s) skipped as trivial by the AI; they remain flagged until documented or bypassed:_`,
      "",
      ...skipped.map(
        (d) =>
          `- \`${d.violation.file}:${d.violation.line}\` — \`${d.violation.symbolName}\``,
      ),
    );
  }

  return lines.join("\n");
}

function countByAction(
  decided: DecidedViolation[],
  action: WhyDecision["action"],
): number {
  return decided.filter((d) => d.decision.action === action).length;
}

function leadingWhitespace(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : "";
}

/**
 * Fallback when `createReview` errors (e.g. all inline comments target
 * lines outside the diff hunk). Posts the same suggest/ask content as a
 * single issue comment so the author still sees the AI's output.
 */
async function postFallbackIssueComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  decided: DecidedViolation[],
): Promise<void> {
  const postable = decided.filter((d) => d.decision.action !== "skip");
  const sections = postable
    .map((d) => {
      const header = `### \`${d.violation.file}:${d.violation.line}\` — \`${d.violation.symbolName}\``;
      return [
        header,
        "",
        `💬 Reply with the "why" — I'll write the docs.`,
      ].join("\n");
    })
    .join("\n\n");

  const body = [
    "<!-- tsdoc-enforcer-fallback -->",
    `📝 **${postable.length} symbol(s) need a quick "why".** (Inline posting failed — per-symbol guidance below.)`,
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

/**
 * Hidden-comment marker stamped on every inline review comment this action
 * posts. The reply handler keys off this prefix to decide whether a reply
 * belongs to one of our threads — any other prefix means "not ours, ignore."
 */
export const REPLY_MARKER_PREFIX = "<!-- tsdoc-enforcer-suggest:v1 ";

/**
 * Encodes a violation into a hidden HTML comment that the reply handler
 * parses to locate the symbol. Using JSON keeps the parser trivial and
 * survives path characters that would need escaping in a freer format.
 */
function buildReplyMarker(v: {
  file: string;
  line: number;
  symbolName: string;
}): string {
  const payload = JSON.stringify({
    path: v.file,
    line: v.line,
    sym: v.symbolName,
  });
  return `${REPLY_MARKER_PREFIX}${payload} -->`;
}

/**
 * Parses the marker out of a parent comment body. Returns `undefined` when
 * the prefix is absent, the JSON is malformed, or required fields are
 * missing — the reply handler treats any of those as "not our thread."
 */
export function parseReplyMarker(
  body: string,
): { path: string; line: number; sym: string } | undefined {
  const start = body.indexOf(REPLY_MARKER_PREFIX);
  if (start < 0) return undefined;
  const jsonStart = start + REPLY_MARKER_PREFIX.length;
  const end = body.indexOf(" -->", jsonStart);
  if (end < 0) return undefined;
  const raw = body.slice(jsonStart, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.path !== "string" ||
    typeof p.line !== "number" ||
    typeof p.sym !== "string"
  ) {
    return undefined;
  }
  return { path: p.path, line: p.line, sym: p.sym };
}
