import * as github from "@actions/github";
import * as core from "@actions/core";

import type { Violation } from "./types";
import { buildPasteablePrompt } from "./prompt";

const MARKER = "<!-- tsdoc-enforcer-no-ai -->";

/**
 * Creates or updates the PR comment for the AI-free variant.
 *
 * Differs from the AI-based comment: there's no generated TSDoc block —
 * only the self-contained prompt the developer can paste into any AI tool
 * (ChatGPT, Claude.ai, Copilot Chat) to get a compliant block. Keeps the
 * developer fully in control and requires no inference access.
 */
export async function upsertPrCommentNoAi(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  violations: Violation[];
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

function renderBody(violations: Violation[]): string {
  const header = `${MARKER}\n🚨 TSDoc missing for ${violations.length} symbol(s). Copy each prompt below into your AI tool, then paste the result above the corresponding symbol.`;
  const sections = violations.map(renderViolation).join("\n\n");
  return `${header}\n\n${sections}\n`;
}

function renderViolation(v: Violation): string {
  const summary = `\`${v.file}:${v.line}\` — \`${v.symbolName}\` (${v.kind})`;
  const prompt = buildPasteablePrompt(v);

  return [
    "<details>",
    `<summary>${summary}</summary>`,
    "",
    "````",
    prompt,
    "````",
    "",
    "</details>",
  ].join("\n");
}
