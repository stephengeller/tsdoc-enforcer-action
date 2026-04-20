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
import type { Violation } from "../core/types";
import { DEFAULT_MODEL, decideWhy, type WhyDecision } from "./generate";
import { postReviewWithDecisions, type DecidedViolation } from "./review";

/**
 * Default cap for how many symbols we'll send to Claude in one PR run.
 *
 * @remarks
 * Caps the worst-case AI spend at roughly 25 × (system_prompt + per_symbol)
 * tokens. PRs above the cap skip AI entirely and post a one-line summary so
 * authors get fast feedback without burning inference budget on what's almost
 * always a mechanical refactor or rename PR.
 */
const DEFAULT_MAX_SYMBOLS_FOR_AI = 25;

async function run(): Promise<void> {
  try {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      core.setFailed("GITHUB_TOKEN is required");
      return;
    }

    const apiKey = core.getInput("anthropic-api-key");
    if (!apiKey) {
      core.setFailed(
        "anthropic-api-key input is required. " +
          "Set it from a workflow secret, e.g. " +
          "`anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}`.",
      );
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
    const model = core.getInput("anthropic-model") || DEFAULT_MODEL;
    const maxSymbolsForAi = readMaxSymbolsForAi();
    const whyConfig = readWhyConfig();
    const bypassActive = hasBypassLabel(pr, bypassLabel);

    core.info(
      `Scanning PR #${prNumber} @ ${headSha} (suggest variant, model=${model})` +
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
      core.info("All changed symbols pass — no comment posted.");
      return;
    }

    if (bypassActive) {
      // Bypass short-circuits AI inference entirely. The point of the label
      // is to spare the team from authoring `@remarks` for trivial PRs;
      // burning Claude tokens to write suggestions nobody will apply
      // defeats the purpose.
      core.info(
        `Bypass label \`${bypassLabel}\` applied — skipping AI inference and passing as informational.`,
      );
      return;
    }

    if (violations.length > maxSymbolsForAi) {
      await postOversizedComment({
        token: githubToken,
        owner,
        repo,
        prNumber,
        violations,
        maxSymbolsForAi,
        bypassLabel,
      });
      core.setFailed(
        `tsdoc-enforcer (suggest): ${violations.length} symbol(s) exceeds the ` +
          `${maxSymbolsForAi}-symbol AI cap. PR is too large for per-symbol ` +
          `why-inference; document manually or apply \`${bypassLabel}\`.`,
      );
      return;
    }

    core.info(
      `Calling Claude (${model}) for ${violations.length} symbol(s)...`,
    );
    const decided = await decideAll({ apiKey, model, violations });

    await postReviewWithDecisions({
      token: githubToken,
      owner,
      repo,
      prNumber,
      headSha,
      decided,
    });

    const suggestN = decided.filter(
      (d) => d.decision.action === "suggest",
    ).length;
    const askN = decided.filter((d) => d.decision.action === "ask").length;
    const skipN = decided.filter((d) => d.decision.action === "skip").length;

    core.setFailed(
      `tsdoc-enforcer (suggest): ${decided.length} symbol(s) need a why from the author ` +
        `(${suggestN} with drafts, ${askN} awaiting a reply, ${skipN} skipped). ` +
        `Authors can reply to any inline comment and the bot will commit the docs.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(`tsdoc-enforcer (suggest) failed: ${message}`);
  }
}

/**
 * Calls {@link decideWhy} for each violation in parallel, swallowing
 * per-symbol failures so one transient 5xx doesn't void the entire run.
 *
 * @remarks
 * Failed symbols collapse to an `ask` with a generic question — better
 * than dropping them silently, because the author still gets a hint that
 * something needs `@remarks` even when the AI couldn't be reached.
 */
async function decideAll(args: {
  apiKey: string;
  model: string;
  violations: Violation[];
}): Promise<DecidedViolation[]> {
  const { apiKey, model, violations } = args;
  const settled = await Promise.allSettled(
    violations.map((violation) => decideWhy({ apiKey, model, violation })),
  );

  return settled.map((result, i) => {
    const violation = violations[i];
    if (result.status === "fulfilled") {
      return { violation, decision: result.value };
    }
    const message =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    core.warning(`Claude call failed for ${violation.symbolName}: ${message}`);
    const fallback: WhyDecision = {
      action: "ask",
      questions: [
        "What constraint, invariant, or upstream behaviour forced this symbol's current shape?",
        "Are there integration quirks (rate limits, ordering requirements, retries) that future maintainers must preserve?",
      ],
      confidence: 0,
      rationale: `Fallback: Claude call errored (${message}).`,
    };
    return { violation, decision: fallback };
  });
}

async function postOversizedComment(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  violations: Violation[];
  maxSymbolsForAi: number;
  bypassLabel: string;
}): Promise<void> {
  const {
    token,
    owner,
    repo,
    prNumber,
    violations,
    maxSymbolsForAi,
    bypassLabel,
  } = args;
  const octokit = github.getOctokit(token);
  const list = violations
    .slice(0, 50)
    .map((v) => `- \`${v.file}:${v.line}\` — \`${v.symbolName}\` (${v.kind})`)
    .join("\n");
  const truncated =
    violations.length > 50 ? `\n\n_…and ${violations.length - 50} more._` : "";

  const body = [
    "<!-- tsdoc-enforcer-oversized -->",
    `📝 **${violations.length} symbol(s) need a "why"** — that's more than the AI cap of ${maxSymbolsForAi}, so I'm not auto-drafting inline comments for this PR.`,
    "",
    "Two options:",
    "",
    "1. Document each symbol yourself (a TSDoc block explaining why it exists), OR",
    `2. Apply the \`${bypassLabel}\` label to acknowledge the PR is too large/mechanical to document per-symbol.`,
    "",
    "Flagged symbols:",
    "",
    list,
    truncated,
  ].join("\n");

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

function readMaxSymbolsForAi(): number {
  const raw = core.getInput("max-symbols-for-ai").trim();
  if (!raw) return DEFAULT_MAX_SYMBOLS_FOR_AI;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  core.warning(
    `max-symbols-for-ai=\`${raw}\` is not a positive integer — using default ${DEFAULT_MAX_SYMBOLS_FOR_AI}.`,
  );
  return DEFAULT_MAX_SYMBOLS_FOR_AI;
}

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
