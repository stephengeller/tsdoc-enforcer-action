import * as github from "@actions/github";
import * as core from "@actions/core";

import type { EnrichedViolation } from "./types";
import { buildPasteablePrompt } from "./prompt";

const MARKER = "<!-- tsdoc-enforcer -->";

/**
 * Creates or updates the single TSDoc-enforcer comment on the PR.
 *
 * Uses a hidden HTML marker to locate any prior comment from this Action
 * and edits it in place, so iterating on a PR doesn't stack a new comment
 * per push.
 */
export async function upsertPrComment(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  violations: EnrichedViolation[];
}): Promise<void> {
  const { token, owner, repo, prNumber, violations } = args;
  const octokit = github.getOctokit(token);

  const body = renderBody(violations);

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

/**
 * Renders the full comment body. The MARKER must stay on the first line
 * so {@link findExistingComment} can locate prior runs regardless of
 * how the rest of the body changes.
 */
function renderBody(violations: EnrichedViolation[]): string {
  const header = `${MARKER}\n🚨 TSDoc missing for ${violations.length} symbol(s). Paste the blocks below directly above each symbol.`;
  const sections = violations.map(renderViolation).join("\n\n");
  return `${header}\n\n${sections}\n`;
}

function renderViolation(v: EnrichedViolation): string {
  // `<summary>` is HTML context — GitHub does NOT parse markdown here, so
  // backticks render literally. Use <code> tags for inline-code styling.
  const summary = `<code>${v.file}:${v.line}</code> — <code>${v.symbolName}</code> (${v.kind})`;
  const pastePrompt = buildPasteablePrompt(v);

  return [
    "<details>",
    `<summary>${summary}</summary>`,
    "",
    "```typescript",
    v.tsdoc,
    "```",
    "",
    "<details>",
    "<summary>Regenerate with your own AI tool</summary>",
    "",
    "````",
    pastePrompt,
    "````",
    "",
    "</details>",
    "</details>",
  ].join("\n");
}
