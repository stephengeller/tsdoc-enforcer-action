import * as core from "@actions/core";
import * as github from "@actions/github";

import { fetchFileAtRef } from "../core/diff";
import { findUndocumentedSymbols } from "../core/analyze";
import { DEFAULT_WHY_RULES_CONFIG } from "../core/why-rules";
import { parseReplyMarker, REPLY_MARKER_PREFIX } from "./review";
import { DEFAULT_MODEL } from "./generate";
import { generateTsdocFromReply } from "./generate-from-reply";
import { spliceTsdocAboveDeclaration } from "./apply-tsdoc";

/**
 * Entry point for the `reply` action variant. Triggered by the
 * `pull_request_review_comment` webhook and applies an author-supplied why
 * by committing an updated TSDoc block back to the PR head branch.
 *
 * @remarks
 * Bails silently on anything that isn't a direct reply to one of our own
 * inline comments: that means we never act on unrelated review threads,
 * top-level review comments, or our own follow-up replies. The hard
 * prerequisites are documented inline where each check runs so a future
 * reader can see the exact condition that gates execution.
 */
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
    if (context.eventName !== "pull_request_review_comment") {
      core.info(
        `Skipping: event is ${context.eventName}, not pull_request_review_comment`,
      );
      return;
    }
    if (context.payload.action !== "created") {
      core.info(
        `Skipping: action is ${context.payload.action}, not created`,
      );
      return;
    }

    const comment = context.payload.comment as ReviewComment | undefined;
    const pr = context.payload.pull_request as PrPayload | undefined;
    if (!comment || !pr) {
      core.info("Skipping: payload missing comment or pull_request.");
      return;
    }

    if (!comment.in_reply_to_id) {
      core.info("Skipping: comment is not a reply (no in_reply_to_id).");
      return;
    }
    if (isBot(comment.user?.login)) {
      core.info(
        `Skipping: comment author ${comment.user?.login} is a bot — ignoring our own replies.`,
      );
      return;
    }

    const model = core.getInput("anthropic-model") || DEFAULT_MODEL;
    const { owner, repo } = context.repo;
    const octokit = github.getOctokit(githubToken);

    const parent = await octokit.rest.pulls.getReviewComment({
      owner,
      repo,
      comment_id: comment.in_reply_to_id,
    });
    if (!isBot(parent.data.user?.login)) {
      core.info(
        `Skipping: parent comment author ${parent.data.user?.login ?? "?"} is not a bot — not a tsdoc-enforcer thread.`,
      );
      return;
    }
    const parentBody = parent.data.body ?? "";
    if (!parentBody.includes(REPLY_MARKER_PREFIX)) {
      core.info(
        "Skipping: parent comment is missing the tsdoc-enforcer marker — not our thread.",
      );
      return;
    }

    const marker = parseReplyMarker(parentBody);
    if (!marker) {
      core.warning(
        "Parent comment has the marker prefix but could not be parsed. Bailing.",
      );
      return;
    }

    const headRepo = pr.head?.repo?.full_name;
    const baseRepo = pr.base?.repo?.full_name;
    if (!headRepo || !baseRepo || headRepo !== baseRepo) {
      await replyInThread(
        octokit,
        owner,
        repo,
        pr.number,
        comment.id,
        "I can't push a commit to a fork branch from the default `GITHUB_TOKEN`. Apply the TSDoc manually or merge into a same-repo branch.",
      );
      core.info(
        `Skipping commit: head=${headRepo ?? "?"} base=${baseRepo ?? "?"} — fork PRs are read-only for the action token.`,
      );
      return;
    }

    const headSha = pr.head.sha;
    const headRef = pr.head.ref;

    const { content: fileContent, sha: fileSha } = await fetchFileAtRef({
      octokit,
      owner,
      repo,
      path: marker.path,
      ref: headSha,
    });

    const analysis = findUndocumentedSymbols(
      [{ path: marker.path, content: fileContent }],
      DEFAULT_WHY_RULES_CONFIG,
    );
    const target = analysis.find(
      (v) => v.symbolName === marker.sym && v.line === marker.line,
    );

    if (!target) {
      await replyInThread(
        octokit,
        owner,
        repo,
        pr.number,
        comment.id,
        `\`${marker.sym}\` is no longer flagged at \`${marker.path}:${marker.line}\` — either you already fixed it or the symbol moved. Re-trigger by pushing a new commit.`,
      );
      core.info(
        `Skipping: symbol ${marker.sym} at ${marker.path}:${marker.line} is not in the current violation set.`,
      );
      return;
    }

    core.info(
      `Generating TSDoc for ${marker.sym} (${target.kind}) from reply (${comment.body?.length ?? 0} chars).`,
    );
    const tsdoc = await generateTsdocFromReply({
      apiKey,
      model,
      symbolName: target.symbolName,
      kind: target.kind,
      path: marker.path,
      symbolSource: target.source,
      replyBody: comment.body ?? "",
    });

    const updated = spliceTsdocAboveDeclaration({
      source: fileContent,
      declarationLine: target.line,
      tsdoc,
    });

    if (updated === fileContent) {
      await replyInThread(
        octokit,
        owner,
        repo,
        pr.number,
        comment.id,
        "Generated block was identical to the existing file content — nothing to commit.",
      );
      return;
    }

    const commit = await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: marker.path,
      branch: headRef,
      message: `docs(${marker.sym}): apply TSDoc from PR reply\n\nAuthored via tsdoc-enforcer reply flow. The author's reply on the\nreview thread explained the why; this commit splices the generated\nTSDoc block above the declaration.`,
      content: Buffer.from(updated, "utf8").toString("base64"),
      sha: fileSha,
    });
    const shortSha = (commit.data.commit.sha ?? "").slice(0, 7);

    await replyInThread(
      octokit,
      owner,
      repo,
      pr.number,
      comment.id,
      `Applied TSDoc for \`${marker.sym}\` in \`${shortSha}\`. The next CI run will confirm the check passes — if the \`@remarks\` still doesn't satisfy the predicate I'll ask again.`,
    );
    core.info(
      `Committed updated TSDoc for ${marker.sym} at ${marker.path}:${marker.line} (${shortSha}).`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(`tsdoc-enforcer (reply) failed: ${message}`);
  }
}

function isBot(login: string | undefined): boolean {
  return !!login && login.endsWith("[bot]");
}

async function replyInThread(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.rest.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    comment_id: commentId,
    body,
  });
}

interface ReviewComment {
  id: number;
  in_reply_to_id?: number;
  body?: string;
  user?: { login?: string };
}

interface PrPayload {
  number: number;
  head: { sha: string; ref: string; repo?: { full_name?: string } };
  base: { repo?: { full_name?: string } };
}

void run();
