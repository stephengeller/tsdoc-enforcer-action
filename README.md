# OEM GitHub Actions

A collection of reusable GitHub Actions for the OEM team. Repository: `stephengeller/github-actions`.

## Actions

| Action                                      | Path                                                   | Purpose                                                     |
| ------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| [Doc Scribe (Suggest)](#doc-scribe-suggest) | `stephengeller/github-actions@main`                    | Claude-powered inline TSDoc review on PRs                   |
| [Doc Scribe (Reply)](#doc-scribe-reply)     | `stephengeller/github-actions/reply@main`              | Commits TSDoc when an author replies to a suggest thread    |
| [Doc Scribe (Report)](#doc-scribe-report)   | `stephengeller/github-actions/report@main`             | AI-free: posts a violation list with a paste-ready prompt   |
| [Auto Downstream PR](#auto-downstream-pr)   | `stephengeller/github-actions/auto-downstream-pr@main` | Opens or updates a downstream PR when an upstream PR merges |

---

## Doc Scribe

Doc Scribe flags TypeScript symbols missing TSDoc, asks the author for the _why_ in an inline review comment, then commits a complete TSDoc block when the author replies. It ships three variants:

- **`suggest`** — posts a PR review with an inline TSDoc suggestion for each symbol whose why is inferable, or targeted questions when it isn't (requires Anthropic key)
- **`reply`** — reacts to review-comment replies on suggest threads: Claude turns the author's why into a complete TSDoc block and commits it back to the PR head
- **`report`** — no inference call; posts a single PR comment listing every violation with a paste-ready prompt you can drop into any AI tool

### What it checks

Every **top-level** symbol on changed `.ts` / `.tsx` files in the PR, regardless of whether it's `export`ed:

| Symbol                                                                   | Required                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Function / method / class / interface / type alias                       | Must have a TSDoc block with a non-empty description                      |
| Function / method with parameters                                        | `@param` for every non-underscore parameter, with a non-empty description |
| Function / method returning anything other than `void` / `Promise<void>` | `@returns` with a non-empty description                                   |

Intentionally **not** checked: private/protected methods inside classes, parameters whose names start with `_`, and nested/arrow functions.

---

### Doc Scribe (Suggest)

Claude-powered inline review. Posts per-symbol TSDoc suggestions or targeted questions. Requires an Anthropic API key.

```yaml
name: Doc Scribe

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

jobs:
  suggest:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: stephengeller/github-actions@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Inputs**

| Input                | Default             | Description                                                                                                                              |
| -------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic-api-key`  | —                   | **Required.** Anthropic API key.                                                                                                         |
| `anthropic-model`    | `claude-sonnet-4-6` | Claude model ID. Override to `claude-opus-4-7` for harder inference or `claude-haiku-4-5-20251001` for cheaper runs.                     |
| `bypass-label`       | `why-acknowledged`  | Apply this label to a PR to skip the why-check entirely (useful for mechanical refactors).                                               |
| `min-remarks-words`  | `15`                | Minimum word count for a `@remarks` block to satisfy the why-acceptance predicate.                                                       |
| `why-keywords`       | `because,so that,…` | Comma-separated causal/constraint keywords. A `@remarks` block needs at least one keyword, a number-with-unit, or a `{@link}` reference. |
| `max-symbols-for-ai` | `25`                | Hard cap on symbols sent to Claude per PR run. Above the cap, the check asks the author to document manually or apply the bypass label.  |

---

### Doc Scribe (Reply)

Triggered by `pull_request_review_comment: [created]`. When an author replies to a Doc Scribe suggest thread, Claude turns the reply into a complete TSDoc block and commits it directly to the PR branch.

```yaml
name: Doc Scribe Reply

on:
  pull_request_review_comment:
    types: [created]

concurrency:
  group: tsdoc-reply-${{ github.event.comment.in_reply_to_id }}
  cancel-in-progress: false

jobs:
  apply:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: stephengeller/github-actions/reply@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The handler only reacts to replies on threads it posted (identified by a hidden marker) and never on its own bot replies. Fork PRs fall back to a manual-apply hint because the default `GITHUB_TOKEN` is read-only on forks.

**Inputs**

| Input               | Default             | Description                      |
| ------------------- | ------------------- | -------------------------------- |
| `anthropic-api-key` | —                   | **Required.** Anthropic API key. |
| `anthropic-model`   | `claude-sonnet-4-6` | Claude model ID.                 |

---

### Doc Scribe (Report)

No Anthropic key required. Posts one PR comment listing every violation with a consolidated prompt you can drop into any AI tool.

```yaml
name: Doc Scribe (report)

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

jobs:
  report:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: stephengeller/github-actions/report@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Inputs**

| Input               | Default             | Description                                                                                  |
| ------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `bypass-label`      | `why-acknowledged`  | Apply this label to soft-bypass the why-check (comment becomes informational, check passes). |
| `min-remarks-words` | `15`                | Minimum word count for a `@remarks` block.                                                   |
| `why-keywords`      | `because,so that,…` | Comma-separated causal/constraint keywords.                                                  |

---

## Auto Downstream PR

A composite action that runs in a **downstream** repo. Given upstream PR metadata as inputs, it runs a user-supplied update command and opens or updates a PR to pull the change in. Designed to be called from an upstream repo's post-merge workflow via `repository_dispatch` or `workflow_call`.

```yaml
name: Downstream bump

on:
  workflow_dispatch:
    inputs:
      upstream-pr-number:
        required: true
      upstream-sha:
        required: true

jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: stephengeller/github-actions/auto-downstream-pr@main
        with:
          token: ${{ secrets.DOWNSTREAM_APP_TOKEN }}
          source-name: my-upstream
          upstream-repo: org/upstream-repo
          upstream-pr-number: ${{ inputs.upstream-pr-number }}
          upstream-sha: ${{ inputs.upstream-sha }}
          update-command: |
            npm install my-upstream@latest
```

The `token` must have `contents: write` and `pull-requests: write` on the downstream repo. Use [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token) to mint one from a GitHub App rather than a PAT.

**Inputs**

| Input                | Required | Default                          | Description                                                                                                                                                                         |
| -------------------- | -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`              | ✓        | —                                | Token with `contents:write` and `pull-requests:write` on the downstream repo.                                                                                                       |
| `source-name`        | ✓        | —                                | Short slug for the upstream source. Used in branch name, commit message, and PR title. Also exposed as `$SOURCE_NAME` inside `update-command`.                                      |
| `upstream-repo`      | ✓        | —                                | `owner/repo` that triggered the run.                                                                                                                                                |
| `upstream-pr-number` | ✓        | —                                | Number of the merged upstream PR.                                                                                                                                                   |
| `upstream-sha`       | ✓        | —                                | Merge commit SHA of the upstream PR.                                                                                                                                                |
| `upstream-title`     |          | `""`                             | Title of the upstream PR (for the PR body).                                                                                                                                         |
| `upstream-author`    |          | `""`                             | GitHub login of the upstream PR author (for the PR body).                                                                                                                           |
| `upstream-url`       |          | `""`                             | HTML URL of the upstream PR (for the PR body).                                                                                                                                      |
| `update-command`     | ✓        | —                                | Shell snippet executed inside the checked-out downstream repo. Must produce a non-empty `git diff`. Environment: `$SOURCE_NAME`, `$UPSTREAM_SHA`, `$UPSTREAM_PR`, `$UPSTREAM_REPO`. |
| `base`               |          | `main`                           | Base branch for the downstream PR.                                                                                                                                                  |
| `branch-prefix`      |          | `auto/bump`                      | Prefix for the branch created in the downstream repo.                                                                                                                               |
| `reviewers`          |          | `""`                             | Comma-separated users/teams to request review from.                                                                                                                                 |
| `labels`             |          | `""`                             | Comma-separated labels to apply.                                                                                                                                                    |
| `commit-message`     |          | templated                        | Override commit message.                                                                                                                                                            |
| `pr-title`           |          | templated                        | Override PR title.                                                                                                                                                                  |
| `git-user-name`      |          | `github-actions[bot]`            | `git config user.name` for the commit.                                                                                                                                              |
| `git-user-email`     |          | `41898282+github-actions[bot]@…` | `git config user.email` for the commit.                                                                                                                                             |

**Outputs**

| Output             | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `pull-request-url` | URL of the created or updated downstream PR.                    |
| `branch`           | Branch pushed to the downstream repo.                           |
| `changed`          | `'true'` if the update-command produced a diff, else `'false'`. |

---

## Local development

```bash
npm install
npm run typecheck
npm run build:all      # builds dist/, report/dist/, reply/dist/ via @vercel/ncc
```

The `dist/` bundles are committed because GitHub Actions runners execute them directly — no `npm install` happens on the consumer side.

## License

MIT
