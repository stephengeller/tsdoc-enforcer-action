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

  return [
    `**Suggested TSDoc for \`${d.violation.symbolName}\`** (${d.violation.kind}) — ${whyChip(d.violation)}.`,
    "",
    "Either click **Apply suggestion** to insert this generated block, or write your own. Either approach satisfies the check as long as the `@remarks` captures the why.",
    "",
    "```suggestion",
    `${indentedDoc}\n${d.violation.originalLine}`,
    "```",
    "",
    `_Confidence: ${d.decision.confidence.toFixed(2)}. Or reply to this comment with the real why and I'll regenerate the TSDoc and commit it for you._`,
  ].join("\n");
}

function buildAskBody(d: DecidedViolation): string {
  if (d.decision.action !== "ask") {
    throw new Error("buildAskBody requires ask decision");
  }
  const questionList = d.decision.questions.map((q) => `- ${q}`).join("\n");

  return [
    `**Why is missing for \`${d.violation.symbolName}\`** (${d.violation.kind}) — ${whyChip(d.violation)}.`,
    "",
    "The why isn't inferable from the source — no nearby constants, error messages, or tests pin down the motivation. Please add a `@remarks` block to the TSDoc that answers the questions below. The check passes once your `@remarks` clears the acceptance predicate (≥15 words, contains a causal keyword / number-with-unit / `{@link}`).",
    "",
    questionList,
    "",
    "_Or just reply to this comment with the why — I'll generate and commit the TSDoc for you._",
  ].join("\n");
}

function buildSummaryBody(decided: DecidedViolation[]): string {
  const suggestN = countByAction(decided, "suggest");
  const askN = countByAction(decided, "ask");
  const skipN = countByAction(decided, "skip");

  const headerCounts = [
    suggestN > 0 ? `**${suggestN}** with paste-ready suggestions` : null,
    askN > 0 ? `**${askN}** awaiting your answers` : null,
    skipN > 0 ? `**${skipN}** marked trivial by AI` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(", ");

  const lines = [
    `🚨 TSDoc / why-capture missing for ${decided.length} symbol(s) — ${headerCounts}.`,
    "",
    "For each inline comment below: apply the suggestion, or write your own TSDoc. The check passes once every flagged symbol has structurally complete TSDoc and a `@remarks` that captures the **why** (motivation / constraints / invariants).",
  ];

  if (skipN > 0) {
    lines.push(
      "",
      "_The following symbols were skipped by the AI as trivial; they remain in the violation set until you either document them or apply the bypass label:_",
      "",
      ...decided
        .filter((d) => d.decision.action === "skip")
        .map(
          (d) =>
            `- \`${d.violation.file}:${d.violation.line}\` — \`${d.violation.symbolName}\``,
        ),
    );
  }

  return lines.join("\n");
}

function whyChip(v: Violation): string {
  const parts: string[] = [];
  if (v.structuralIncomplete) parts.push("structural TSDoc incomplete");
  if (v.whyStatus === "missing") parts.push("`@remarks` missing");
  else if (v.whyStatus === "weak") {
    parts.push(
      `weak \`@remarks\`${v.whyFailureReason ? ` (${v.whyFailureReason})` : ""}`,
    );
  }
  return parts.join(", ");
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
  const sections = decided
    .filter((d) => d.decision.action !== "skip")
    .map((d) => {
      const header = `### \`${d.violation.file}:${d.violation.line}\` — \`${d.violation.symbolName}\` (${d.violation.kind})`;
      if (d.decision.action === "suggest") {
        return [header, "", "```typescript", d.decision.tsdocFull, "```"].join(
          "\n",
        );
      }
      if (d.decision.action === "ask") {
        return [
          header,
          "",
          "_The why isn't inferable from the source. Please answer in a `@remarks` block:_",
          "",
          ...d.decision.questions.map((q) => `- ${q}`),
        ].join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  const body = [
    "<!-- tsdoc-enforcer-fallback -->",
    `🚨 TSDoc / why-capture missing for ${decided.length} symbol(s). Inline-suggestion posting failed — see the per-symbol guidance below.`,
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
