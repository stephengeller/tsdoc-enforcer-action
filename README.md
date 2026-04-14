# tsdoc-enforcer-action

A GitHub Action that fails pull requests when TypeScript symbols are missing or have incomplete [TSDoc](https://tsdoc.org), and posts a single PR comment with AI-generated doc blocks — ready to paste directly above each symbol.

**Zero API keys. Zero cost.** Uses [GitHub Models](https://docs.github.com/en/github-models) (`openai/gpt-4o-mini`) with the workflow's built-in `GITHUB_TOKEN` — consumers just add a workflow YAML and it works.

When a violation is found, the comment also includes the exact prompt that was used to generate the block, so you can regenerate or tweak it in ChatGPT, Claude.ai, Copilot Chat, or any other AI tool.

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

Two variants ship from this repo. Pick one:

### Variant A — AI-powered (recommended)

Generates paste-ready TSDoc blocks via GitHub Models. **Requires the org to have enabled GitHub Models.** If your org hasn't opted in, the Action will 403 with a clear error — switch to Variant B.

```yaml
name: TSDoc Enforcer

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  tsdoc:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      models: read
    steps:
      - uses: actions/checkout@v4
      - uses: stephengeller/tsdoc-enforcer-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Variant B — AI-free (works everywhere)

No inference call. Instead of a generated block, the comment contains a **self-contained prompt** for each violation — paste it into ChatGPT, Claude.ai, Copilot Chat, or any other AI tool, and paste the result back above the symbol. Works on any repo with zero org setup.

```yaml
name: TSDoc Enforcer

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  tsdoc:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: stephengeller/tsdoc-enforcer-action/no-ai@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Note the path suffix `/no-ai` and the absence of `models: read`.

**Both variants share identical enforcement rules** — the check will flag the same symbols either way. They only differ in what the PR comment contains.

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

## Rate limits

GitHub Models has a free-tier rate limit shared across all workflows for the repo/org. If you exceed it on an unusually large PR, the Action will report the limit error and fail — fix is either retry later or split the PR. For typical volume (tens of flagged symbols per PR, handful of PRs per day) you won't hit it.

---

## How it works (internals)

1. **Diff** (`src/diff.ts`) — paginates `pulls.listFiles`, filters to `.ts` / `.tsx`, fetches each blob at the PR head SHA
2. **Analyze** (`src/analyze.ts` + `src/tsdoc-rules.ts`) — [ts-morph](https://ts-morph.com) walks each source file; collects top-level functions/classes/public methods/interfaces/type-aliases (regardless of `export` keyword); applies the tag-aware predicate
3. **Generate** (`src/generate.ts` + `src/prompt.ts`) — calls GitHub Models (`openai/gpt-4o-mini`) per symbol via the OpenAI-compatible endpoint at `https://models.github.ai/inference`; extracts the `/** ... */` block from the response
4. **Comment** (`src/comment.ts`) — finds/updates the Action's comment via a hidden HTML marker; renders nested `<details>` sections

---

## Local development

```bash
npm install
npm run typecheck
npm run build          # produces dist/index.js via @vercel/ncc
```

The `dist/` bundle is committed because GitHub Actions runners execute it directly — no `npm install` happens on the consumer side.

---

## Roadmap (maybe)

- Prose-quality grading via a second model pass (would catch `@param id - the id`)
- `@throws` enforcement on functions containing `throw` statements
- Configurable inputs (model choice, strictness level)
- Optional provider override (use a paid Anthropic/OpenAI key for better output)

## License

MIT
