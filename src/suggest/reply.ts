import * as core from "@actions/core";
import * as github from "@actions/github";

import { fetchFileAtRef } from "../core/diff";
import { findUndocumentedSymbols } from "../core/analyze";
import { DEFAULT_WHY_RULES_CONFIG } from "../core/why-rules";
import { parseReplyMarker, REPLY_MARKER_PREFIX } from "./review";
import { DEFAULT_MODEL } from "./generate";
import { generateTsdocFromReply } from "./generate-from-reply";
import { spliceTsdocAboveDeclaration } from "./apply-tsdoc";
import { isReplyThin } from "./thin-reply";

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

    const headRef = pr.head.ref;

    // Fetch from the branch tip (headRef), not the frozen headSha from the
    // event payload, so back-to-back replies see each other's commits and
    // don't splice on top of stale content. The commit API still rejects on
    // SHA mismatch, but with this fetch the blob SHA matches the tip by
    // default — races only happen if another commit lands during the Claude
    // call, which the workflow-level concurrency group in tsdoc-reply.yml
    // additionally guards against.
    const { content: fileContent, sha: fileSha } = await fetchFileAtRef({
      octokit,
      owner,
      repo,
      path: marker.path,
      ref: headRef,
    });

    const analysis = findUndocumentedSymbols(
      [{ path: marker.path, content: fileContent }],
      DEFAULT_WHY_RULES_CONFIG,
    );
    // Match by symbol name — the marker's `line` is frozen at posting time,
    // but earlier reply-to-apply commits in the same PR splice TSDoc above
    // other symbols and shift this one downward. `line` is only a tiebreaker
    // for overloaded / same-named symbols within one file.
    const byName = analysis.filter((v) => v.symbolName === marker.sym);
    const target =
      byName.length === 0
        ? undefined
        : byName.length === 1
          ? byName[0]
          : byName.reduce((best, v) =>
              Math.abs(v.line - marker.line) < Math.abs(best.line - marker.line)
                ? v
                : best,
            );

    if (!target) {
      await replyInThread(
        octokit,
        owner,
        repo,
        pr.number,
        comment.id,
        `\`${marker.sym}\` is no longer flagged in \`${marker.path}\` — either you already fixed it or the symbol was renamed/removed.`,
      );
      core.info(
        `Skipping: symbol ${marker.sym} is not in the current violation set for ${marker.path}.`,
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

    const ackBody = buildAckBody({
      symbol: marker.sym,
      shortSha,
      replyWasThin: isReplyThin(comment.body),
    });
    await replyInThread(
      octokit,
      owner,
      repo,
      pr.number,
      comment.id,
      ackBody,
    );
    core.info(
      `Committed updated TSDoc for ${marker.sym} at ${marker.path}:${marker.line} (${shortSha}).`,
    );

    // Resolve the thread the reply was on so it falls off the reviewer's
    // "unresolved" list. Non-fatal — a GraphQL error here shouldn't mask the
    // successful commit above, so we log and move on. The thread can still be
    // resolved manually if the mutation failed.
    await tryResolveThread({
      githubToken,
      owner,
      repo,
      prNumber: pr.number,
      parentCommentId: comment.in_reply_to_id,
      symbolName: marker.sym,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(`tsdoc-enforcer (reply) failed: ${message}`);
  }
}

/**
 * Builds the reply body posted after a successful commit-from-reply.
 *
 * @remarks
 * Two variants — a plain "thanks, committed" for substantive replies, and a
 * gentler variant that acknowledges the commit while inviting the author to
 * reply again with more context. The split is driven by {@link isReplyThin};
 * the ack itself is always celebratory so a junior author never feels
 * blocked by a thin first answer.
 */
function buildAckBody(args: {
  symbol: string;
  shortSha: string;
  replyWasThin: boolean;
}): string {
  const { symbol, shortSha, replyWasThin } = args;
  if (!replyWasThin) {
    return `✅ Committed docs for \`${symbol}\` in \`${shortSha}\`. Thanks!`;
  }
  return [
    `✅ Committed docs for \`${symbol}\` in \`${shortSha}\`.`,
    "",
    "The reply was brief so the doc is best-effort — reply again with more context if you'd like me to rewrite it.",
  ].join("\n");
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

/**
 * Marks the review thread that carried the original inline comment as
 * resolved via the GraphQL `resolveReviewThread` mutation.
 *
 * @remarks
 * The REST comment id (`parentCommentId`) can't feed the mutation directly —
 * `resolveReviewThread` takes a GraphQL node ID. We paginate the PR's review
 * threads, match by the first comment's `databaseId`, and mutate on the hit.
 * Pagination is capped at 10 pages × 100 threads to avoid unbounded calls on
 * old high-traffic PRs; if the marker comment is beyond that cutoff the
 * resolution silently no-ops, which is fine because the commit already
 * landed — thread resolution is presentational, not correctness-critical.
 */
async function tryResolveThread(args: {
  githubToken: string;
  owner: string;
  repo: string;
  prNumber: number;
  parentCommentId: number;
  symbolName: string;
}): Promise<void> {
  const { githubToken, owner, repo, prNumber, parentCommentId, symbolName } =
    args;
  const octokit = github.getOctokit(githubToken);

  try {
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: ThreadsPage = await octokit.graphql(THREADS_QUERY, {
        owner,
        repo,
        pr: prNumber,
        cursor,
      });
      const threads = res.repository.pullRequest.reviewThreads.nodes;
      for (const thread of threads) {
        const first = thread.comments.nodes[0];
        if (first && first.databaseId === parentCommentId) {
          if (thread.isResolved) {
            core.info(
              `Thread for ${symbolName} already resolved; skipping mutation.`,
            );
            return;
          }
          await octokit.graphql(RESOLVE_MUTATION, { threadId: thread.id });
          core.info(`Resolved review thread for ${symbolName}.`);
          return;
        }
      }
      const pageInfo = res.repository.pullRequest.reviewThreads.pageInfo;
      if (!pageInfo.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }
    core.info(
      `No review thread matched parent comment ${parentCommentId} for ${symbolName}; leaving thread state unchanged.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(
      `Failed to resolve review thread for ${symbolName}: ${message}`,
    );
  }
}

const THREADS_QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 1) { nodes { databaseId } }
          }
        }
      }
    }
  }
`;

const RESOLVE_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { isResolved }
    }
  }
`;

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: { nodes: Array<{ databaseId: number }> };
        }>;
      };
    };
  };
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
