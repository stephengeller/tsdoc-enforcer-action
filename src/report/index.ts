import * as core from "@actions/core";
import * as github from "@actions/github";

import { getChangedTypeScriptFiles } from "../core/diff";
import { findUndocumentedSymbols } from "../core/analyze";
import { upsertPrComment } from "./comment";

async function run(): Promise<void> {
  try {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      core.setFailed("GITHUB_TOKEN is required");
      return;
    }

    const { context } = github;
    if (context.eventName !== "pull_request" || !context.payload.pull_request) {
      core.info(`Skipping: event is ${context.eventName}, not pull_request`);
      return;
    }

    const pr = context.payload.pull_request;
    const { owner, repo } = context.repo;
    const prNumber = pr.number;
    const headSha = pr.head.sha as string;

    core.info(`Scanning PR #${prNumber} @ ${headSha} (no-ai variant)`);

    const changedFiles = await getChangedTypeScriptFiles({
      token: githubToken,
      owner,
      repo,
      prNumber,
    });
    core.info(`Changed .ts/.tsx files: ${changedFiles.length}`);

    if (changedFiles.length === 0) {
      core.info("No TypeScript files changed — passing.");
      return;
    }

    const violations = findUndocumentedSymbols(changedFiles);
    core.info(`Undocumented exported symbols: ${violations.length}`);

    if (violations.length === 0) {
      core.info(
        "All changed exported symbols are documented — passing silently.",
      );
      return;
    }

    await upsertPrComment({
      token: githubToken,
      owner,
      repo,
      prNumber,
      violations,
    });

    core.setFailed(
      `TSDoc missing for ${violations.length} exported symbol(s). See PR comment for paste-ready prompts.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(`tsdoc-enforcer (no-ai) failed: ${message}`);
  }
}

void run();
