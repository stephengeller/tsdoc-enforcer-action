# Junior-friendly bot copy

**Status:** approved
**Date:** 2026-04-20
**Driver:** PR #12 review shows the bot leads with TSDoc formatting rules and forensic questions — intimidating for junior authors and off-target for what we actually want (an explanation of *why* the code exists).

## Problem

The bot's user-facing copy assumes the author knows and cares about TSDoc
internals. Today's inline comments expose the acceptance predicate (`≥15 words`,
`causal keyword / number-with-unit / {@link}`), the `@remarks` tag, confidence
scores, and 4–5 LLM-generated forensic questions per symbol. For a junior
author raising a PR, this reads as homework about documentation formatting
rather than the actual request: *tell us the motivation behind the code*.

The bot already knows how to write the TSDoc. What it needs from the author is
a sentence of intent.

## Goal

Reframe every author-facing surface so that:

1. The headline action is always **"reply with the why"**.
2. No TSDoc jargon appears in the comment body — no `@remarks`, no
   `acceptance predicate`, no `≥15 words`, no `{@link}`, no confidence scores.
3. Comments are thin. Any content beyond the one-line ask goes into
   collapsed `<details>` blocks.
4. Authors are never frustrated by a thin reply — the bot commits a best-effort
   doc and gently invites them to elaborate.

## Non-goals

- Changing the underlying acceptance predicate or rule engine.
- Softening the style of the *committed* TSDoc prose.
- Changing bypass-label behavior, diff-detection, or any non-copy path.

## Surfaces

Five author-facing strings change. Source file → current behavior →
new behavior.

### A. Top-of-review summary — `src/suggest/review.ts` `buildSummaryBody`

**New:**

> 📝 **N symbol(s) need a quick "why".** Reply to each inline comment with a
> sentence on why the code exists — I'll write the docs for you.

No mention of "suggest" vs "ask" counts, no predicate language, no per-class
breakdown unless `skip` count > 0 (in which case append the existing trivial
list as today).

### B. Inline "suggest" comment — `buildSuggestBody`

**New:**

> 💬 **Reply with the "why" for `<symbol>`** — I'll write the docs.
>
> <details><summary>Examples of a good "why" reply</summary>
>
> *(two LLM-picked one-liners relevant to this symbol)*
> </details>
>
> <details><summary>Or, use my draft</summary>
>
> ```suggestion
> <generated TSDoc block>
> ```
> </details>

Reply stays the headline; the draft is secondary, collapsed by default. No
confidence score rendered.

### C. Inline "ask" comment — `buildAskBody`

**New:**

> 💬 **Reply with the "why" for `<symbol>`** — I'll write the docs.
>
> <details><summary>Examples of a good "why" reply</summary>
>
> *(two LLM-picked one-liners relevant to this symbol)*
> </details>

No forensic questions. No predicate language.

### D. Reply-ack after commit — `src/suggest/reply.ts` (line ~222)

Two variants. The existing commit-ack site picks one based on a `replyWasThin`
boolean.

**Solid reply:**

> ✅ Committed docs for `<symbol>` in `<shortSha>`. Thanks!

**Thin reply:**

> ✅ Committed docs for `<symbol>` in `<shortSha>`.
>
> The reply was brief so the doc is best-effort — reply again with more context
> if you'd like me to rewrite it.

### E. Fallback issue comment — `postFallbackIssueComment`

Mirror Surface A's tone at the header; per-symbol block becomes:

> ### `<file>:<line>` — `<symbol>`
> 💬 Reply with the "why" — I'll write the docs.

## LLM prompt changes

### `src/suggest/generate.ts`

- Remove `questions` from the `ask` branch of the tool-response schema and from
  the prompt that produces it. The author never sees them now.
- Remove `confidence` from the `suggest` branch output (or keep it internally
  for logging but drop it from the comment body — see Surface B).
- Add a new optional field to both branches: `whyExamples: [string, string]`.
  Prompt the LLM to produce two short, concrete "why"-style one-liners
  relevant to *this specific symbol* (drawing on the same source-nearby signals
  it already inspects). These populate the collapsed example block in
  Surfaces B and C.

### `src/suggest/generate-from-reply.ts`

- Drop the "if the reply is empty/off-topic, emit a `@remarks` that slips a
  causal keyword in" branch. The bot should never ship docs that lie about
  having a why.
- The LLM always produces real prose reflecting whatever the author wrote,
  even if thin. Thin-reply detection (below) decides the ack variant, not the
  commit content.

## Thin-reply detection

Deterministic, no LLM call:

- Strip `{@link ...}` fragments and markdown formatting from the author's
  reply.
- Count whitespace-separated tokens.
- `tokens < 10` ⇒ `replyWasThin = true`.

Applied in `reply.ts` after the commit succeeds; gates the Surface D variant.
Word cap is tunable via a constant (`THIN_REPLY_WORD_THRESHOLD`) so we can
dial it without another PR.

## Testing

### Unit tests

- `buildSummaryBody`, `buildSuggestBody`, `buildAskBody`, `buildReplyAck`:
  snapshot-test the new strings; verify the hidden `tsdoc-enforcer-suggest:v1`
  marker is still attached to inline comments.
- Thin-reply counter: table-test with inputs at 9 / 10 / 11 tokens, with
  punctuation, with `{@link}` fragments, with leading/trailing whitespace,
  and with an empty string.

### Dogfood

- Fresh branch off `main` carrying the same 4-symbol `__dogfood-test__.ts`
  fixture used in PR #12.
- Visually verify: the three new surfaces render as designed, collapsed
  sections collapse, and reply-to-apply still commits successfully.
- Confirm the `reply-ack` switches variants: one thin reply (≤5 words) and
  one solid reply (≥20 words) on the same PR.

## Rollout

Single PR. All five surfaces move together — mixing old and new tones in a
single review would look worse than either alone. No feature flag; if the
copy regresses we revert.

## Future work (not in this spec)

- Progressive strictness: once authors are fluent with the gentler flow, we
  can tighten the acceptance predicate or surface a subtle "your why was
  thin" signal without changing the conversational tone.
- Soften the committed TSDoc prose itself — currently reads quite formal
  ("Inserts a delay of `RATE_LIMIT_DELAY_MS`…"); a later pass could make it
  sound more like a human wrote it.
