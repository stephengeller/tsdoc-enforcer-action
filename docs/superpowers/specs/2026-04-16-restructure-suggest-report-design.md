# Restructure: Suggest / Report variants

**Date:** 2026-04-16
**Status:** Approved

## Problem

The codebase has two GitHub Action variants — one that uses AI to generate inline TSDoc suggestions, and one that simply reports missing docs with a PR comment. They currently live as flat files in `src/` with unclear naming (`index.ts` vs `index-no-ai.ts`, `comment-no-ai.ts`). The shared core is not visually separated from variant-specific code.

## Decision

Rename the variants to **suggest** (AI-powered inline suggestions) and **report** (flags missing docs, no AI). Restructure `src/` into three directories: `core/`, `suggest/`, `report/`.

## Target structure

```
# Repo root
action.yml                  <- suggest (flagship, unchanged path for backwards compat)
report/action.yml           <- report variant (replaces no-ai/action.yml)

# Source
src/
  core/
    analyze.ts
    diff.ts
    prompt.ts
    tsdoc-rules.ts
    types.ts
  suggest/
    index.ts                <- entrypoint
    generate.ts             <- AI doc generation (GitHub Models)
    review.ts               <- inline suggestion posting
  report/
    index.ts                <- entrypoint
    comment.ts              <- PR comment posting
```

## File moves

| From | To |
|---|---|
| `src/analyze.ts` | `src/core/analyze.ts` |
| `src/diff.ts` | `src/core/diff.ts` |
| `src/prompt.ts` | `src/core/prompt.ts` |
| `src/tsdoc-rules.ts` | `src/core/tsdoc-rules.ts` |
| `src/types.ts` | `src/core/types.ts` |
| `src/index.ts` | `src/suggest/index.ts` |
| `src/generate.ts` | `src/suggest/generate.ts` |
| `src/review.ts` | `src/suggest/review.ts` |
| `src/index-no-ai.ts` | `src/report/index.ts` |
| `src/comment-no-ai.ts` | `src/report/comment.ts` |

## Import path changes

- Files in `src/suggest/` and `src/report/` import from `../core/...` instead of `./...`
- Intra-variant imports stay relative (e.g. `./generate`, `./comment`)

## Action YMLs

- `action.yml` (root): update name to "TSDoc Enforcer (Suggest)", `main` stays `dist/index.js`
- `report/action.yml`: update name to "TSDoc Enforcer (Report)", `main` stays `dist/index.js`

## Build config

```json
"build": "ncc build src/suggest/index.ts -o dist --license licenses.txt",
"build:report": "ncc build src/report/index.ts -o report/dist --license licenses.txt",
"build:all": "npm run build && npm run build:report"
```

Renames `build:no-ai` to `build:report`.

## Cleanup

- Delete `no-ai/` directory
- Delete all old flat files from `src/`

## Scope

No logic changes. Every function body stays identical. This is purely a restructure + rename.

## Consumer impact

- `uses: stephengeller/tsdoc-enforcer-action@v1` continues to work (root `action.yml` unchanged path)
- `uses: stephengeller/tsdoc-enforcer-action/no-ai@v1` breaks and must change to `uses: stephengeller/tsdoc-enforcer-action/report@v1`
