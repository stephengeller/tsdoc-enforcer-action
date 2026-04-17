import * as github from "@actions/github";
import * as core from "@actions/core";

import type { Violation } from "../core/types";
import { buildCombinedPrompt } from "../core/prompt";

const MARKER = "<!-- tsdoc-enforcer-no-ai -->";

/**
 * Creates or updates the PR comment for the AI-free variant.
 *
 * @remarks
 * The comment lists every flagged symbol with a short reason chip
 * (`STRUCTURE` for missing `@param`/`@returns`, `WHY` for missing/weak
 * `@remarks`), then a templated `@remarks` skeleton per why-flagged symbol
 * the author can copy-paste, then a single collapsible AI prompt that covers
 * all symbols in one round-trip. Bypass-label instructions go at the end so
 * a reviewer who decides the PR is trivial knows the exact label to apply.
 *
 * Idempotent: a hidden marker on the comment lets re-runs update in place
 * rather than spam new comments per push.
 */
export async function upsertPrComment(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  violations: Violation[];
  bypassLabel: string;
  bypassActive: boolean;
}): Promise<void> {
  const {
    token,
    owner,
    repo,
    prNumber,
    violations,
    bypassLabel,
    bypassActive,
  } = args;
  const octokit = github.getOctokit(token);

  const body = renderBody({ violations, bypassLabel, bypassActive });

  const existing = await findExistingComment(octokit, owner, repo, prNumber);
  if (existing) {
    core.info(`Updating existing comment #${existing.id}`);
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    return;
  }

  core.info("Creating new comment");
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

async function findExistingComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ id: number } | undefined> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const match = comments.find((c) => (c.body ?? "").includes(MARKER));
  return match ? { id: match.id } : undefined;
}

function renderBody(args: {
  violations: Violation[];
  bypassLabel: string;
  bypassActive: boolean;
}): string {
  const { violations, bypassLabel, bypassActive } = args;
  const whyViolations = violations.filter((v) => v.whyStatus !== "ok");

  const headerIcon = bypassActive ? "ℹ️" : "🚨";
  const headerVerb = bypassActive
    ? `Bypassed by \`${bypassLabel}\` label — informational only.`
    : `Flagged ${violations.length} symbol(s).`;
  const header = `${MARKER}\n${headerIcon} **TSDoc enforcer (report)** — ${headerVerb}`;

  const list = violations
    .map((v, i) => {
      const chips: string[] = [];
      if (v.structuralIncomplete) chips.push("`STRUCTURE`");
      if (v.whyStatus !== "ok") chips.push("`WHY`");
      const reason = v.whyFailureReason
        ? ` — ${v.whyFailureReason}`
        : v.structuralIncomplete
          ? " — missing `@param`/`@returns` or description"
          : "";
      return `${i + 1}. ${chips.join(" ")} \`${v.file}:${v.line}\` — \`${v.symbolName}\` (${v.kind})${reason}`;
    })
    .join("\n");

  const sections: string[] = [header, "", "### Symbols flagged", "", list];

  if (whyViolations.length > 0) {
    sections.push(
      "",
      "### Why-capture reminder",
      "",
      "These symbols are missing a `@remarks` block that explains *why* the code is the way it is — constraints, invariants, integration quirks. The structural docs say what the code does; reviewers and future maintainers need the why. Paste a draft like this above each symbol and fill it in:",
      "",
      "```typescript",
      "/**",
      " * <existing description>",
      " *",
      " * @remarks",
      " * <Why does this exist? What constraint, invariant, or upstream behaviour forced",
      " * this approach? Aim for ≥15 words and use a causal phrase (`because`, `so that`,",
      " * `must`, `to ensure`) or a number-with-unit (`200ms`, `4 KB`) — the predicate",
      " * looks for these signals.>",
      " */",
      "```",
      "",
      "**Per-symbol checklist:**",
      "",
      whyViolations
        .map(
          (v) =>
            `- [ ] \`${v.file}:${v.line}\` \`${v.symbolName}\` — ${v.whyFailureReason ?? "add @remarks"}`,
        )
        .join("\n"),
    );
  }

  const prompt = buildCombinedPrompt(violations);
  sections.push(
    "",
    "<details>",
    "<summary>&nbsp;<strong>Copy this prompt into your AI tool</strong></summary>",
    "",
    "````md",
    prompt,
    "````",
    "",
    "</details>",
    "",
    "---",
    "",
    bypassActive
      ? `_This check is currently passing because the \`${bypassLabel}\` label is applied. Remove the label to re-enable enforcement._`
      : `_To bypass enforcement on this PR (e.g. trivial change, infra-only, generated code), apply the \`${bypassLabel}\` label. The check will pass and this comment will switch to informational._`,
    "",
  );

  return sections.join("\n");
}
