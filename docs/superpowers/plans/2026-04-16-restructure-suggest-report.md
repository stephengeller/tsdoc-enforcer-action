# Restructure: Suggest / Report Variants — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize flat `src/` into `src/core/`, `src/suggest/`, `src/report/` and rename the "no-ai" variant to "report".

**Architecture:** Move shared files into `src/core/`, variant-specific files into `src/suggest/` and `src/report/`. Update all import paths. Update build scripts and action.yml files. No logic changes.

**Tech Stack:** TypeScript, ncc (bundler), GitHub Actions

---

### Task 1: Create directory structure and move core files

**Files:**
- Create: `src/core/` directory
- Move: `src/analyze.ts` → `src/core/analyze.ts`
- Move: `src/diff.ts` → `src/core/diff.ts`
- Move: `src/prompt.ts` → `src/core/prompt.ts`
- Move: `src/tsdoc-rules.ts` → `src/core/tsdoc-rules.ts`
- Move: `src/types.ts` → `src/core/types.ts`

- [ ] **Step 1: Create the core directory and move files**

```bash
mkdir -p src/core
git mv src/analyze.ts src/core/analyze.ts
git mv src/diff.ts src/core/diff.ts
git mv src/prompt.ts src/core/prompt.ts
git mv src/tsdoc-rules.ts src/core/tsdoc-rules.ts
git mv src/types.ts src/core/types.ts
```

- [ ] **Step 2: Fix internal imports within core files**

`src/core/analyze.ts` — change:
```typescript
import type { ChangedFile, Violation } from "./types";
import { isTsDocIncomplete } from "./tsdoc-rules";
```
These stay the same (still `./` relative within core). No change needed.

`src/core/tsdoc-rules.ts` — change:
```typescript
import type { DocumentableNode } from "./analyze";
import type { Violation } from "./types";
```
These stay the same. No change needed.

`src/core/prompt.ts` — change:
```typescript
import type { Violation } from "./types";
```
Stays the same. No change needed.

`src/core/diff.ts` — change:
```typescript
import type { ChangedFile } from "./types";
```
Stays the same. No change needed.

All core files only import from each other, so no import paths change in this step.

- [ ] **Step 3: Verify typecheck fails (expected — entrypoints still reference old paths)**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: errors about missing modules in `src/index.ts` and `src/index-no-ai.ts` (they still import from `./analyze`, `./diff`, etc.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move shared files into src/core/"
```

---

### Task 2: Move suggest variant files and fix imports

**Files:**
- Create: `src/suggest/` directory
- Move: `src/index.ts` → `src/suggest/index.ts`
- Move: `src/generate.ts` → `src/suggest/generate.ts`
- Move: `src/review.ts` → `src/suggest/review.ts`
- Modify: `src/suggest/index.ts` (import paths)
- Modify: `src/suggest/generate.ts` (import paths)
- Modify: `src/suggest/review.ts` (import paths)

- [ ] **Step 1: Create the suggest directory and move files**

```bash
mkdir -p src/suggest
git mv src/index.ts src/suggest/index.ts
git mv src/generate.ts src/suggest/generate.ts
git mv src/review.ts src/suggest/review.ts
```

- [ ] **Step 2: Update imports in `src/suggest/index.ts`**

Change:
```typescript
import { getChangedTypeScriptFiles } from "./diff";
import { findUndocumentedSymbols } from "./analyze";
import { generateTsDoc } from "./generate";
import { postReviewWithSuggestions } from "./review";
```
To:
```typescript
import { getChangedTypeScriptFiles } from "../core/diff";
import { findUndocumentedSymbols } from "../core/analyze";
import { generateTsDoc } from "./generate";
import { postReviewWithSuggestions } from "./review";
```

- [ ] **Step 3: Update imports in `src/suggest/generate.ts`**

Change:
```typescript
import type { Violation } from "./types";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";
```
To:
```typescript
import type { Violation } from "../core/types";
import { SYSTEM_PROMPT, buildUserMessage } from "../core/prompt";
```

- [ ] **Step 4: Update imports in `src/suggest/review.ts`**

Change:
```typescript
import type { EnrichedViolation } from "./types";
```
To:
```typescript
import type { EnrichedViolation } from "../core/types";
```

- [ ] **Step 5: Verify typecheck passes for suggest variant**

Run: `npx tsc --noEmit 2>&1 | grep -c "error"` 
Expected: only errors from `src/index-no-ai.ts` (not yet moved). No errors referencing `src/suggest/`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move suggest variant into src/suggest/"
```

---

### Task 3: Move report variant files and fix imports

**Files:**
- Create: `src/report/` directory
- Move: `src/index-no-ai.ts` → `src/report/index.ts`
- Move: `src/comment-no-ai.ts` → `src/report/comment.ts`
- Modify: `src/report/index.ts` (import paths)
- Modify: `src/report/comment.ts` (import paths)

- [ ] **Step 1: Create the report directory and move files**

```bash
mkdir -p src/report
git mv src/index-no-ai.ts src/report/index.ts
git mv src/comment-no-ai.ts src/report/comment.ts
```

- [ ] **Step 2: Update imports in `src/report/index.ts`**

Change:
```typescript
import { getChangedTypeScriptFiles } from "./diff";
import { findUndocumentedSymbols } from "./analyze";
import { upsertPrCommentNoAi } from "./comment-no-ai";
```
To:
```typescript
import { getChangedTypeScriptFiles } from "../core/diff";
import { findUndocumentedSymbols } from "../core/analyze";
import { upsertPrComment } from "./comment";
```

Also update the call site inside the function body — change `upsertPrCommentNoAi` to `upsertPrComment`.

- [ ] **Step 3: Rename the exported function in `src/report/comment.ts`**

Change:
```typescript
export async function upsertPrCommentNoAi(args: {
```
To:
```typescript
export async function upsertPrComment(args: {
```

Also update the import in `src/report/comment.ts`:
Change:
```typescript
import type { Violation } from "./types";
import { buildCombinedPrompt } from "./prompt";
```
To:
```typescript
import type { Violation } from "../core/types";
import { buildCombinedPrompt } from "../core/prompt";
```

- [ ] **Step 4: Verify full typecheck passes**

Run: `npx tsc --noEmit`
Expected: 0 errors. All files now live in their new locations with correct imports.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move report variant into src/report/"
```

---

### Task 4: Update action.yml files

**Files:**
- Modify: `action.yml`
- Move: `no-ai/action.yml` → `report/action.yml`
- Delete: `no-ai/` directory

- [ ] **Step 1: Update root `action.yml` name**

Change the `name` field:
```yaml
name: "TSDoc Enforcer (Suggest)"
description: "Fails PRs that add TypeScript symbols without TSDoc, and posts AI-generated doc blocks as inline suggestions."
```

`runs.main` stays `dist/index.js` — unchanged.

- [ ] **Step 2: Move and update report action.yml**

```bash
mkdir -p report
git mv no-ai/action.yml report/action.yml
```

Update `report/action.yml`:
```yaml
name: "TSDoc Enforcer (Report)"
description: "Fails PRs that add TypeScript symbols without TSDoc. Posts a PR comment listing missing docs with a paste-ready AI prompt."
```

`runs.main` stays `dist/index.js` — unchanged (it's relative to the action.yml directory, so `report/dist/index.js` is correct).

- [ ] **Step 3: Remove old no-ai directory**

```bash
rm -rf no-ai/
git add -A
```

The `no-ai/dist/` bundle will be replaced by `report/dist/` when we rebuild in Task 5.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rename action.yml files (no-ai -> report)"
```

---

### Task 5: Update build config and rebuild

**Files:**
- Modify: `package.json` (scripts section)

- [ ] **Step 1: Update package.json build scripts**

Change:
```json
"build": "ncc build src/index.ts -o dist --license licenses.txt",
"build:no-ai": "ncc build src/index-no-ai.ts -o no-ai/dist --license licenses.txt",
"build:all": "npm run build && npm run build:no-ai",
```
To:
```json
"build": "ncc build src/suggest/index.ts -o dist --license licenses.txt",
"build:report": "ncc build src/report/index.ts -o report/dist --license licenses.txt",
"build:all": "npm run build && npm run build:report",
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: passes with 0 errors.

- [ ] **Step 3: Run full build**

Run: `npm run build:all`
Expected: both `dist/index.js` and `report/dist/index.js` are produced without errors.

- [ ] **Step 4: Commit**

```bash
git add package.json dist/ report/dist/
git commit -m "build: update scripts for suggest/report structure and rebuild"
```

---

### Task 6: Verify and clean up

- [ ] **Step 1: Verify no stale files remain in `src/`**

Run: `ls src/`
Expected: only `core/`, `suggest/`, `report/` directories. No loose `.ts` files.

- [ ] **Step 2: Verify action.yml paths are correct**

Run: `cat action.yml | grep main` — should show `dist/index.js`
Run: `cat report/action.yml | grep main` — should show `dist/index.js`

- [ ] **Step 3: Verify dist bundles exist**

Run: `ls dist/index.js report/dist/index.js`
Expected: both files exist.

- [ ] **Step 4: Final typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit any remaining cleanup (if needed)**

```bash
git status
# If clean, no commit needed
```
