# sync-from-upstream

A composite GitHub Action that runs inside a **downstream** repo on a schedule,
compares each of its **upstream** sources to the SHA currently pinned here, and
opens a PR pulling any drift in.

The companion [`auto-downstream-pr`](../auto-downstream-pr/) action implements
the **push** variant of the same automation (fires instantly when an upstream
PR merges). This action implements the **poll** variant, with very different
operational trade-offs.

## When to use the poll variant over push

| Concern                                     | Push (`auto-downstream-pr`)                                   | Poll (`sync-from-upstream`) — this action              |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| Adding a new integration                    | Install App on upstream repo + add secret + add workflow file | **One line in the downstream repo's workflow**         |
| Per-upstream config                         | GitHub App install, repo var, repo secret, workflow file      | None                                                   |
| Trust boundary                              | Org settings: which Apps are installed with `actions: write`  | **The integrations list in the YAML is the allowlist** |
| Latency from upstream merge → downstream PR | Seconds                                                       | Up to `cron_interval` + GitHub scheduling jitter       |
| Recovery from missed events                 | None — dropped dispatch = no PR                               | Self-healing — next tick picks it up                   |

**Pick this variant if:**

- You have many upstreams and don't want org-admin clicks on every new one.
- You want the set of active integrations to live in code under review, not
  in settings UIs.
- A ~5–15 minute latency on auto-bump PRs is acceptable (humans review them
  anyway).

**Pick push instead if:**

- You need sub-minute latency (e.g. the bump unblocks a downstream deploy).
- You only have one or two upstreams ever, so per-upstream config is cheap.

## Cost model

GitHub Actions bills per minute of runner wall-clock, per job. This action is
specifically designed to minimise both:

- **Single job, bash loop** — one runner boot (~10–15s) amortised across all
  integrations. A matrix shape across N integrations pays that tax N times.
- **No `actions/checkout` on the fast path** — drift detection is two `gh api`
  calls per integration, so the common "nothing changed" tick finishes in
  ~10–15s total. Checkout only runs when we've already confirmed a real bump.

At **5-minute cadence** (GitHub's `schedule:` floor), typical cost:

| Shape                                     | Billed min/month | GitHub Team (3k free) | Enterprise (50k free) |
| ----------------------------------------- | ---------------- | --------------------- | --------------------- |
| This action, no drift                     | ~2,160           | ~72% used             | ~4% used              |
| This action, 3 drifts/day average         | ~2,200           | ~73% used             | ~4% used              |
| Matrix variant, 10 integrations, no drift | ~14,400          | Exceeded              | ~29% used             |

Dropping cadence to every 15 min cuts those numbers by 3×. Restricting to
business hours (`cron: "*/15 8-19 * * 1-5"`) cuts ~4× further.

## Setup

### 1. One GitHub App installed across everything

Unlike the push variant, you need exactly **one** bot App for the entire
setup:

- Installed on the downstream repo with `contents: write` + `pull_requests: write`.
- Installed on every upstream repo with `contents: read`.

Adding a new upstream later = install the App on the new repo. No new App, no
new key, no new secret.

### 2. Store the App credentials in the downstream repo

- Variable: `AMBER_BOT_APP_ID` (or whatever name you use in the workflow).
- Secret: `AMBER_BOT_PRIVATE_KEY` (full `.pem` contents).

You can also put these at org level (Settings → Secrets and variables →
Actions → New organization secret), scoped to just the downstream repo, if
your org prefers central management.

### 3. Drop in the consumer workflow

Copy [`examples/amber-core-sync.yml`](examples/amber-core-sync.yml) to the
downstream repo at `.github/workflows/sync-oem-integrations.yml` and adjust:

- `integrations:` — the list of upstream sources to poll.
- `pinned-sha-command:` — how to read the currently-pinned SHA for an
  integration without cloning. Recipes below.
- `update-command:` — how to apply the bump. Recipes below.
- `app-id` / `private-key` — the var/secret names you chose.

## Recipes

### `pinned-sha-command` recipes

The action runs this for each integration on the fast path, with
`$SOURCE_NAME` and `$UPSTREAM_REPO` in scope. Must print the pinned SHA to
stdout. **Must not require a local checkout** — use `gh api`.

**git-subrepo** (pinned SHA lives in `<path>/.gitrepo`):

```bash
gh api "repos/${GITHUB_REPOSITORY}/contents/oem/${SOURCE_NAME}/.gitrepo" \
  -q .content | base64 -d \
  | awk -F= '/^[[:space:]]*commit[[:space:]]*=/ {gsub(/ /,""); print $2}'
```

**Git submodule** (SHA is the gitlink object in the tree):

```bash
gh api "repos/${GITHUB_REPOSITORY}/contents/vendor/${SOURCE_NAME}" \
  -q .sha
```

**Go module** (SHA baked into the pseudo-version in `go.mod`):

```bash
gh api "repos/${GITHUB_REPOSITORY}/contents/go.mod" \
  -q .content | base64 -d \
  | awk -v mod="github.com/${UPSTREAM_REPO}" '
      $0 ~ mod { match($0, /-([a-f0-9]{12})$/, m); print m[1] }'
```

**Pinned SHA in a YAML config**:

```bash
gh api "repos/${GITHUB_REPOSITORY}/contents/config/sources.yml" \
  -q .content | base64 -d \
  | yq ".sources.${SOURCE_NAME}.ref"
```

### `update-command` recipes

Runs in the checked-out repo on a fresh branch once drift is confirmed. Must
produce a non-empty `git diff`. Env: `$SOURCE_NAME`, `$UPSTREAM_REPO`,
`$UPSTREAM_REF`, `$UPSTREAM_SHA`.

```bash
# git-subrepo
git subrepo pull "oem/${SOURCE_NAME}"

# submodule
git -C "vendor/${SOURCE_NAME}" fetch origin "${UPSTREAM_SHA}"
git -C "vendor/${SOURCE_NAME}" checkout "${UPSTREAM_SHA}"

# go module
go get "github.com/${UPSTREAM_REPO}@${UPSTREAM_SHA}"
go mod tidy

# yq config
yq -i ".sources.${SOURCE_NAME}.ref = \"${UPSTREAM_SHA}\"" config/sources.yml
```

## Inputs

| Name                 | Required | Default               | Description                                                     |
| -------------------- | -------- | --------------------- | --------------------------------------------------------------- |
| `token`              | yes      | —                     | App installation token, write on this repo + read on upstreams. |
| `integrations`       | yes      | —                     | JSON array of `{name, repo, ref?}` entries.                     |
| `pinned-sha-command` | yes      | —                     | Shell snippet; prints currently pinned SHA for one entry.       |
| `update-command`     | yes      | —                     | Shell snippet; applies the bump. Must produce a diff.           |
| `base`               | no       | `main`                | Base branch for downstream PRs.                                 |
| `branch-prefix`      | no       | `auto/bump`           | Prefix for generated branches.                                  |
| `reviewers`          | no       | `""`                  | Comma-separated users/teams per PR.                             |
| `labels`             | no       | `""`                  | Comma-separated labels per PR.                                  |
| `git-user-name`      | no       | `github-actions[bot]` | Commit author name.                                             |
| `git-user-email`     | no       | GitHub bot email      | Commit author email.                                            |

## Outputs

- `stale-count` — number of integrations found drifted this run.
- `bumped` — JSON array of `{name, url}` for PRs opened or updated.

## Behaviour notes

- **Deterministic branches.** Branch name is
  `<branch-prefix>-<source-name>-<short-sha>`. Re-running on the same upstream
  SHA updates the same PR; a new upstream commit opens a new PR.
- **Per-integration failure isolation.** A failing `update-command` for one
  integration is logged as a warning and the others still run.
- **No-diff runs are silent.** If `update-command` produces no diff (e.g. the
  drift was in a file we don't track), no PR is opened — the integration
  will be re-checked next tick and the "drift detected" notice will fire
  again until the underlying pin is updated.

## Design decisions

- **Composite action, not JS/Docker.** No build step; reviewers can read the
  shipped YAML directly. Matches the rest of this repo.
- **Single job, bash loop.** See cost model above — dominant lever on minutes.
- **User-supplied `pinned-sha-command` and `update-command`.** Kept generic
  so the action doesn't assume git-subrepo, or any particular pinning scheme.
- **Fast-path `gh api`, not checkout.** A scheduled check-and-act workflow
  that clones on every tick spends 90% of its time on the git clone. Putting
  checkout behind an `if:` guard is the single biggest perf win available.
- **The integrations list IS the security boundary.** New integration = PR to
  this file. No side-channel (org settings, new App install) can make an
  unlisted upstream get auto-bumped here.
