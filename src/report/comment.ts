import * as github from "@actions/github";
import * as core from "@actions/core";

import type { Violation } from "../core/types";
import { buildCombinedPrompt } from "../core/prompt";

const MARKER = "<!-- tsdoc-enforcer-no-ai -->";

/**
 * Creates or updates the PR comment for the AI-free variant.
 *
 * Posts a markdown list of the undocumented symbols followed by a single
 * collapsible prompt the developer can paste into any AI tool once to get
 * TSDoc blocks for all symbols in a single response.
 */
export async function upsertPrComment(args: {
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
  const header = `${MARKER}\n🚨 TSDoc missing for ${violations.length} symbol(s). Copy the prompt below into your AI tool **once**, then paste each returned block above its corresponding symbol.`;

  const list = violations
    .map(
      (v, i) =>
        `${i + 1}. \`${v.file}:${v.line}\` — \`${v.symbolName}\` (${v.kind})`,
    )
    .join("\n");

  const prompt = buildCombinedPrompt(violations);

  return [
    header,
    "",
    "### Symbols flagged",
    "",
    list,
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
  ].join("\n");
}
