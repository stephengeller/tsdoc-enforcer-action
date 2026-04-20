# tsdoc-enforcer-action

A GitHub Action that fails pull requests when TypeScript symbols are missing or have incomplete [TSDoc](https://tsdoc.org), and — on top of structural checks — enforces a *why-shaped* `@remarks` block so reviewers and future maintainers can see the motivation, constraints, and invariants behind each symbol.

Ships three variants from this repo:

- **`suggest`** (root, Anthropic Claude) — posts a PR review with an inline TSDoc suggestion for each symbol whose why is inferable, or targeted questions when it isn't.
- **`reply`** (`/reply`) — reacts to review-comment replies on the suggest threads: Claude turns the author's why into a complete TSDoc block and commits it back to the PR head.
- **`report`** (`/report`, AI-free) — no inference call. Posts a single PR comment listing every violation with a paste-ready prompt you can drop into any AI tool.

---

## What it checks

Every **top-level** symbol on changed `.ts` / `.tsx` files in the PR, regardless of whether it's `export`ed:

| Symbol                                                                   | Required                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Function / method / class / interface / type alias                       | Must have a TSDoc block with a non-empty description                      |
| Function / method with parameters                                        | `@param` for every non-underscore parameter, with a non-empty description |
| Function / method returning anything other than `void` / `Promise<void>` | `@returns` with a non-empty description                                   |

Intentionally **not** checked:

- Private / protected methods inside classes
- Parameters whose names start with `_` (convention: intentionally unused)
- Nested functions, arrow functions assigned to variables, and other non-top-level declarations

Prose _quality_ is not graded — `@param id - the id` passes structural checks even though it's useless.

---

## Usage

All three variants share identical structural + why-capture enforcement rules; they differ only in what they post and whether they require an Anthropic key.

### suggest — Claude-powered inline review (recommended)

```yaml
name: TSDoc Enforcer

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
      - uses: stephengeller/tsdoc-enforcer-action@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Set an `ANTHROPIC_API_KEY` repo secret first. Apply the `why-acknowledged` label on a PR to bypass the check (useful for mechanical refactors where authoring `@remarks` per symbol adds no value).

### reply — commit the author's why back as TSDoc

Pair with the suggest variant. When an author replies to one of its inline comments, Claude turns the reply into a complete TSDoc block and commits it directly to the PR branch.

```yaml
name: TSDoc Apply Reply

on:
  pull_request_review_comment:
    types: [created]

concurrency:
  group: tsdoc-reply-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  apply:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: stephengeller/tsdoc-enforcer-action/reply@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The handler only reacts to replies on threads it posted (identified by a hidden marker), never on unrelated review comments, and never on its own bot replies. Fork PRs fall back to a manual-apply hint because the default `GITHUB_TOKEN` is read-only on forks.

### report — AI-free, paste-ready prompt

No Anthropic key required. Posts one PR comment listing every violation with a consolidated prompt you can drop into any AI tool.

```yaml
name: TSDoc Enforcer (report)

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
      - uses: stephengeller/tsdoc-enforcer-action/report@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## What happens on a PR

- ✅ **All changed exports are documented** → the Action passes silently, no comment.
- 🚨 **Any changed export is missing/incomplete** → the Action:
  1. Fails the check (exit 1), blocking the PR if the check is required
  2. Posts/updates a single PR comment listing every violation with:
     - `file:line — symbol (kind)` heading
     - A `typescript` fenced block with the AI-generated TSDoc — paste directly above the symbol
     - A collapsible "Regenerate with your own AI tool" section containing the full self-contained prompt

The comment upserts — pushing more commits to the PR updates the existing comment instead of stacking new ones.

---

## Example output

> 🚨 TSDoc missing for 1 symbol(s). Paste the blocks below directly above each symbol.
>
> <details>
> <summary><code>src/users.ts:42</code> — <code>fetchUserById</code> (function)</summary>
>
> ```typescript
> /**
>  * Fetches the user with the given id, returning `null` when no row exists.
>  *
>  * @param id - Primary key of the user to fetch.
>  * @param client - Database client used to issue the query.
>  * @returns The user row, or `null` when the id doesn't exist.
>  */
> ```
>
> <details>
> <summary>Regenerate with your own AI tool</summary>
>
> ```
> <full paste-ready prompt: system rules + this specific symbol>
> ```
>
> </details>
> </details>

---

## Rate limits and cost

Anthropic enforces per-workspace rate limits that vary by tier; a single PR hitting dozens of symbols can burst through the per-minute cap. The suggest variant has a `max-symbols-for-ai` input (default `25`) that guards against runaway spend on large mechanical PRs — above that cap, the check posts a one-line summary and asks the author to either document manually or apply the bypass label.

The report variant makes zero inference calls and has no Anthropic rate-limit exposure.

---

## How it works (internals)

1. **Diff** (`src/core/diff.ts`) — paginates `pulls.listFiles`, filters to `.ts` / `.tsx`, fetches each blob at the PR head SHA.
2. **Analyze** (`src/core/analyze.ts` + `src/core/tsdoc-rules.ts` + `src/core/why-rules.ts`) — [ts-morph](https://ts-morph.com) walks each source file; collects top-level functions / classes / public methods / interfaces / type-aliases (regardless of `export` keyword); applies both the structural TSDoc predicate and the rule-based why-acceptance predicate.
3. **Route/render** — the suggest variant calls Anthropic Claude per symbol via the `record_why_decision` tool and posts a PR review with inline suggestions or questions; the report variant skips inference and upserts a single PR comment with a consolidated prompt.
4. **Reply** (`src/suggest/reply.ts`) — triggered by `pull_request_review_comment: [created]`; validates the thread is one of ours via a hidden marker, turns the reply body into a TSDoc block, commits it to the PR head branch, and resolves the thread.

The rule-based why-acceptance predicate is deterministic — Claude authors *candidate* remarks, but the predicate alone decides pass/fail, so the check never flaps between runs on identical code.

---

## Local development

```bash
npm install
npm run typecheck
npm run build:all      # builds dist/, report/dist/, reply/dist/ via @vercel/ncc
```

The `dist/` bundles are committed because GitHub Actions runners execute them directly — no `npm install` happens on the consumer side.

---

## Roadmap (maybe)

- Prose-quality grading via a second model pass (would catch `@param id - the id`)
- `@throws` enforcement on functions containing `throw` statements
- Cut a stable release tag once the three-variant shape settles

## License

MIT
