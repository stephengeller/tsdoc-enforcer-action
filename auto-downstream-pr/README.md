# auto-downstream-pr

A composite GitHub Action for automating the pattern:

> When a PR merges on an **upstream** repo, automatically open (or update) a PR
> on a **downstream** repo that pulls the change in.

The update itself is driven by a user-supplied shell snippet, so the action is
agnostic to how the downstream repo consumes upstream changes (go.mod bump,
pinned SHA in a config file, `git subrepo pull`, submodule update, regenerated
artifact — whatever fits your setup).

Ships as **two composite actions** because the work spans two repos:

| Action                       | Runs in         | Purpose                                                          |
| ---------------------------- | --------------- | ---------------------------------------------------------------- |
| `auto-downstream-pr/trigger` | Upstream repo   | On PR merge, fires a `workflow_dispatch` at the downstream repo. |
| `auto-downstream-pr`         | Downstream repo | Runs the update command, commits, opens or updates a PR.         |

## Topology

```
┌──────────────────┐     gh workflow run      ┌──────────────────┐
│ upstream repo    │ ───────────────────────▶ │ downstream repo  │
│  PR merged →     │   (workflow_dispatch     │  bump workflow   │
│  trigger action  │    with PR metadata)     │  → update-command│
└──────────────────┘                          │  → open/edit PR  │
                                              └──────────────────┘
```

## Authentication

The default `GITHUB_TOKEN` cannot dispatch workflows or open PRs in another
repo. Use a **GitHub App** installed on both the upstream and downstream
repos, and mint an installation token per run with
`actions/create-github-app-token@v1`.

Required App permissions:

- On **upstream repos**: `actions: write` (to dispatch).
- On **downstream repo**: `contents: write`, `pull_requests: write`.

A PAT on a bot/service account works too for quick setups, but an App is
preferred for org-wide deployments.

---

## Setup

### 1. Downstream repo: the bump workflow

```yaml
# .github/workflows/bump-from-upstream.yml
name: Bump from upstream
on:
  workflow_dispatch:
    inputs:
      source-name: { required: true, type: string }
      upstream-repo: { required: true, type: string }
      upstream-pr-number: { required: true, type: string }
      upstream-sha: { required: true, type: string }
      upstream-title: { required: false, type: string, default: "" }
      upstream-author: { required: false, type: string, default: "" }
      upstream-url: { required: false, type: string, default: "" }

jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: token
        with:
          app-id: ${{ vars.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}

      # Install any tools your update-command needs here.

      - uses: stephengeller/github-actions/auto-downstream-pr@main
        with:
          token: ${{ steps.token.outputs.token }}
          source-name: ${{ inputs.source-name }}
          upstream-repo: ${{ inputs.upstream-repo }}
          upstream-pr-number: ${{ inputs.upstream-pr-number }}
          upstream-sha: ${{ inputs.upstream-sha }}
          upstream-title: ${{ inputs.upstream-title }}
          upstream-author: ${{ inputs.upstream-author }}
          upstream-url: ${{ inputs.upstream-url }}
          update-command: |
            # Your bump logic here. Must produce a non-empty `git diff`.
            # See "Update-command recipes" below.
```

### 2. Upstream repo: the trigger workflow

```yaml
# .github/workflows/notify-downstream.yml
name: Notify downstream
on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  notify:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: token
        with:
          app-id: ${{ vars.BOT_APP_ID }}
          private-key: ${{ secrets.BOT_PRIVATE_KEY }}
          owner: your-org
          repositories: your-downstream-repo

      - uses: stephengeller/github-actions/auto-downstream-pr/trigger@main
        with:
          token: ${{ steps.token.outputs.token }}
          downstream-repo: your-org/your-downstream-repo
          downstream-workflow: bump-from-upstream.yml
          source-name: my-source
```

---

## Update-command recipes

The action is deliberately un-opinionated about how the downstream repo
consumes the upstream. Pick whichever matches your setup.

**Go module bump**

```bash
go get github.com/your-org/${SOURCE_NAME}@${UPSTREAM_SHA}
go mod tidy
```

**Pinned SHA in a YAML config** (requires `yq`)

```bash
yq -i ".sources[\"${SOURCE_NAME}\"].ref = \"${UPSTREAM_SHA}\"" config/sources.yml
```

**Git submodule**

```bash
git -C vendor/${SOURCE_NAME} fetch origin "${UPSTREAM_SHA}"
git -C vendor/${SOURCE_NAME} checkout "${UPSTREAM_SHA}"
```

**`git subrepo` pull** (requires [`git-subrepo`](https://github.com/ingydotnet/git-subrepo) installed on the runner)

```bash
git subrepo pull "path/to/${SOURCE_NAME}"
```

Environment available inside `update-command`: `$SOURCE_NAME`,
`$UPSTREAM_SHA`, `$UPSTREAM_PR`, `$UPSTREAM_REPO`.

---

## `auto-downstream-pr` inputs (downstream action)

| Name                 | Required | Default     | Description                                 |
| -------------------- | -------- | ----------- | ------------------------------------------- |
| `token`              | yes      | —           | Token with write access on this repo.       |
| `source-name`        | yes      | —           | Short slug identifying the upstream source. |
| `upstream-repo`      | yes      | —           | `owner/repo` that triggered the run.        |
| `upstream-pr-number` | yes      | —           | Merged PR number.                           |
| `upstream-sha`       | yes      | —           | Merge commit SHA.                           |
| `upstream-title`     | no       | `""`        | For PR body.                                |
| `upstream-author`    | no       | `""`        | For PR body.                                |
| `upstream-url`       | no       | computed    | For PR body.                                |
| `update-command`     | yes      | —           | Shell snippet; must produce a diff.         |
| `base`               | no       | `main`      | Base branch of the downstream PR.           |
| `branch-prefix`      | no       | `auto/bump` | Branch name prefix.                         |
| `reviewers`          | no       | `""`        | Comma-separated users/teams.                |
| `labels`             | no       | `""`        | Comma-separated labels.                     |
| `commit-message`     | no       | templated   | Override commit message.                    |
| `pr-title`           | no       | templated   | Override PR title.                          |

### Outputs

- `pull-request-url` — URL of the created/updated PR.
- `branch` — Branch pushed.
- `changed` — `"true"` if the update produced a diff.

## `trigger` inputs (upstream action)

| Name                  | Required | Default | Description                                       |
| --------------------- | -------- | ------- | ------------------------------------------------- |
| `token`               | yes      | —       | Token with `actions: write` on downstream.        |
| `downstream-repo`     | yes      | —       | `owner/repo` hosting the bump workflow.           |
| `downstream-workflow` | yes      | —       | Workflow filename, e.g. `bump-from-upstream.yml`. |
| `downstream-ref`      | no       | `main`  | Branch to dispatch against.                       |
| `source-name`         | yes      | —       | Short slug identifying this source.               |

---

## Behaviour notes

- **Per-merge branches.** Branch name is `<branch-prefix>-<source-name>-pr-<upstream-pr-number>` — derived from the upstream PR number, so reruns update the existing branch/PR instead of creating duplicates. The push uses `--force-with-lease`.
- **No diff → no PR.** If `update-command` produces no change, the run exits cleanly without opening anything.
- **Reviewer / label failures don't fail the run.** They emit a warning — the PR is still created/updated.

## Design

- **Composite actions**, not JS/Docker. No build step; the YAML is the source.
- **Two actions, two repos.** Splitting the trigger from the worker mirrors the actual topology and lets each side evolve independently.
- **User-supplied `update-command`.** Required input, no default — the action makes no assumption about how your downstream repo consumes upstream changes.
