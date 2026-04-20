import * as core from "@actions/core";
import * as github from "@actions/github";

import { getChangedTypeScriptFiles } from "../core/diff";
import { findUndocumentedSymbols } from "../core/analyze";
import {
  DEFAULT_WHY_KEYWORDS,
  DEFAULT_WHY_RULES_CONFIG,
  type WhyRulesConfig,
} from "../core/why-rules";
import { DEFAULT_BYPASS_LABEL, hasBypassLabel } from "../core/bypass";
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

    const bypassLabel = core.getInput("bypass-label") || DEFAULT_BYPASS_LABEL;
    const whyConfig = readWhyConfig();
    const bypassActive = hasBypassLabel(pr, bypassLabel);

    core.info(
      `Scanning PR #${prNumber} @ ${headSha} (report variant)` +
        (bypassActive ? ` — bypass label \`${bypassLabel}\` is active` : ""),
    );

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

    const violations = findUndocumentedSymbols(changedFiles, whyConfig);
    core.info(
      `Flagged symbols: ${violations.length} ` +
        `(structural=${violations.filter((v) => v.structuralIncomplete).length}, ` +
        `why=${violations.filter((v) => v.whyStatus !== "ok").length})`,
    );

    if (violations.length === 0) {
      core.info("All changed symbols are documented and have why — passing.");
      return;
    }

    await upsertPrComment({
      token: githubToken,
      owner,
      repo,
      prNumber,
      violations,
      bypassLabel,
      bypassActive,
    });

    if (bypassActive) {
      core.info(
        `Bypass label \`${bypassLabel}\` applied — passing as informational.`,
      );
      return;
    }

    core.setFailed(
      `doc-scribe (report): ${violations.length} symbol(s) need attention. ` +
        `See PR comment for the per-symbol checklist and paste-ready prompt.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(`doc-scribe (report) failed: ${message}`);
  }
}

/**
 * Reads the why-acceptance predicate's tuning knobs from action inputs.
 *
 * @remarks
 * Both knobs are optional — empty input means use the default. We re-validate
 * `min-remarks-words` because GitHub passes inputs as strings; a typo like
 * `"15 "` shouldn't silently fall back to NaN comparisons in the predicate.
 */
function readWhyConfig(): WhyRulesConfig {
  const minRaw = core.getInput("min-remarks-words").trim();
  const keywordsRaw = core.getInput("why-keywords").trim();

  let minRemarksWords = DEFAULT_WHY_RULES_CONFIG.minRemarksWords;
  if (minRaw) {
    const parsed = Number.parseInt(minRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      minRemarksWords = parsed;
    } else {
      core.warning(
        `min-remarks-words=\`${minRaw}\` is not a positive integer — using default ${minRemarksWords}.`,
      );
    }
  }

  const whyKeywords = keywordsRaw
    ? keywordsRaw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    : [...DEFAULT_WHY_KEYWORDS];

  return { minRemarksWords, whyKeywords };
}

void run();
