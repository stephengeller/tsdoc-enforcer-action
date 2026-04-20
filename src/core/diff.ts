import * as github from "@actions/github";
import * as core from "@actions/core";

import type { ChangedFile } from "./types";

const TS_EXTENSIONS = /\.(ts|tsx)$/;

/**
 * Fetches every `.ts` / `.tsx` file added or modified by the given PR and
 * returns its full source at the PR's head SHA.
 *
 * Removed and renamed-away files are excluded — we can't lint what no longer
 * exists, and the base version of a renamed file is irrelevant.
 */
export async function getChangedTypeScriptFiles(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<ChangedFile[]> {
  const { token, owner, repo, prNumber } = args;
  const octokit = github.getOctokit(token);

  const pr = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const headSha = pr.data.head.sha;

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const candidates = files.filter(
    (f) =>
      TS_EXTENSIONS.test(f.filename) &&
      f.status !== "removed" &&
      f.status !== "unchanged",
  );

  core.debug(
    `PR #${prNumber}: ${files.length} total changed, ${candidates.length} ts/tsx candidates`,
  );

  const results: ChangedFile[] = [];
  for (const file of candidates) {
    try {
      const { content } = await fetchFileAtRef({
        octokit,
        owner,
        repo,
        path: file.filename,
        ref: headSha,
      });
      results.push({ path: file.filename, content });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      core.warning(
        `Skipping ${file.filename}: could not fetch content (${message})`,
      );
    }
  }

  return results;
}

export async function fetchFileAtRef(args: {
  octokit: ReturnType<typeof github.getOctokit>;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}): Promise<{ content: string; sha: string }> {
  const { octokit, owner, repo, path, ref } = args;
  const res = await octokit.rest.repos.getContent({ owner, repo, path, ref });

  if (Array.isArray(res.data) || res.data.type !== "file") {
    throw new Error(
      `expected a file blob at ${path}, got ${Array.isArray(res.data) ? "directory" : res.data.type}`,
    );
  }

  const encoded = res.data.content;
  return {
    content: Buffer.from(encoded, "base64").toString("utf8"),
    sha: res.data.sha,
  };
}
