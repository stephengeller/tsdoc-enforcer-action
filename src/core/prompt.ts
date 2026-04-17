import type { Violation } from "./types";

/**
 * System prompt used for every TSDoc generation request in a PR run.
 *
 * Kept stable across calls so Anthropic's ephemeral prompt cache serves
 * repeat hits at ~90% discount — don't inline volatile state here.
 *
 * Rules match the Option C enforcement predicate in `tsdoc-rules.ts`,
 * so a block generated from this prompt will always pass our own check.
 */
export const SYSTEM_PROMPT = `You are a TSDoc generator for TypeScript code with a second responsibility: ensuring each symbol's documentation captures the WHY (motivation, constraints, invariants), not just the WHAT.

OUTPUT CONTRACT
- Respond with ONLY a TSDoc block, starting with /** and ending with */.
- No preamble, no trailing commentary, no code fences, no prose outside the block.

STYLE (strict TSDoc per tsdoc.org)
- Description: 1–2 sentences. Neutral technical tone.
- Describe the symbol's contract (what it guarantees, what it returns, when it fails), not its mechanics. Do not restate the signature in prose — avoid phrasings like "Takes a string and returns a string".
- Use \`backticks\` for inline identifiers and literal values.
- Reference other symbols with {@link OtherSymbol}, not @see.

TAGS
- Include @param for every non-underscore parameter, with a concise comment describing the parameter's meaning.
- Include @returns for functions and methods that return anything other than void or Promise<void>.
- Include @remarks when — and only when — the surrounding source makes the WHY inferable. See WHY-INFERENCE below.
- Do NOT include @example blocks.
- Do NOT include @throws (not enforced in v1).

WHY-INFERENCE
- The WHY of a symbol is the motivation, constraint, or invariant that forced its shape: integration quirks, rate limits, ordering requirements, compatibility with upstream systems, security considerations. Not the same as the WHAT (which is covered by the description).
- Inferable signals: named constants with units (\`DELAY_MS = 200\`), nearby error messages that explain a condition, adjacent tests that assert an invariant, throw statements that name a constraint, comments in the surrounding code.
- NON-inferable (do NOT invent): domain history, team preferences, product requirements, external contracts. If these shaped the code but are not visible in the source, ask the author.
- A good @remarks is ≥15 words and uses at least one: causal keyword (because, so that, to ensure, must, cannot, requires, avoid, prevent, invariant, otherwise), a number with a unit (200ms, 4 KB), or a {@link} reference.
- Do not write boilerplate remarks that restate the description. If you cannot infer a real why, return action=ask.

CONSTRAINTS
- Do not invent behavior that is not visible in the source.
- If a parameter's purpose is unclear from the source, write a minimal honest description rather than speculating.
- Prefer brevity. A short accurate block is strictly better than a long one that fabricates detail.

EXAMPLE INPUT
\`\`\`typescript
const RATE_LIMIT_DELAY_MS = 200; // upstream allows at most 5 rps

export async function fetchUserById(id: string, client: DbClient): Promise<User | null> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const row = await client.query('SELECT * FROM users WHERE id = $1', [id])
  return row ?? null
}
\`\`\`

EXAMPLE OUTPUT
/**
 * Fetches the user with the given id, returning \`null\` when no row exists.
 *
 * @remarks
 * Inserts a 200ms delay before every call because the upstream database allows
 * at most 5 requests per second and we cannot afford rate-limit errors on the
 * hot read path. See {@link RATE_LIMIT_DELAY_MS} for the tuning constant.
 *
 * @param id - Primary key of the user to fetch.
 * @param client - Database client used to issue the query.
 * @returns The user row, or \`null\` when the id doesn't exist.
 */`;

/**
 * Per-symbol user message that asks Claude to emit a `WhyDecision` via the
 * `record_why_decision` tool.
 *
 * @remarks
 * Kept outside the cached system prompt so the static prefix is reused across
 * every symbol in the PR — this matters because the system prompt is the
 * largest cached chunk and prompt-cache hits are billed at ~10% of fresh
 * input tokens. Communicates the symbol's current `whyStatus` so the model
 * knows whether `@remarks` is absent (`missing`), present-but-weak (`weak`),
 * or already acceptable but the structural TSDoc is what's failing (`ok`).
 */
export function buildWhyDecisionMessage(violation: Violation): string {
  const lines = [
    `Decide what to do for this ${violation.kind} named \`${violation.symbolName}\` from \`${violation.file}\`.`,
    "",
    `Current why status: **${violation.whyStatus}**${violation.whyFailureReason ? ` — ${violation.whyFailureReason}` : ""}.`,
    `Structural TSDoc complete: ${violation.structuralIncomplete ? "NO" : "yes"}.`,
    "",
    "Source:",
    "```typescript",
    violation.source,
    "```",
    "",
    "Use the `record_why_decision` tool to record your decision. Specifically:",
    '- `action: "suggest"` ONLY when you can infer a real why from the source above (named constants with units, nearby error messages, throw statements that name constraints, adjacent tests). Provide the full TSDoc block including a why-shaped `@remarks`. Set `confidence` honestly — anything below 0.7 will be downgraded to `ask`.',
    '- `action: "ask"` when the why is not inferable from the source. List 3–5 specific questions a senior reviewer would ask the author (e.g. "Why a 200ms delay before the call?", "What invariant does the early return on line 12 preserve?"). Avoid vague questions like "Why does this exist?".',
    '- `action: "skip"` for trivial wrappers, type re-exports, or symbols whose why genuinely is just a pure restatement of the description.',
    "",
    "Always populate `rationale` with one short sentence justifying your choice — it is logged for diagnostics and forces you to commit to a reason.",
  ];
  return lines.join("\n");
}

/**
 * Returns a single prompt that asks an external AI tool to generate TSDoc
 * blocks for every violation in one pass. Used by the report (no-AI) variant
 * so the developer copy-pastes once instead of per-symbol.
 *
 * @remarks
 * The output contract is tightened to include a location label before each
 * block so the developer can find the right target symbol for each result.
 * The combined prompt also nudges the AI to add `@remarks` for symbols whose
 * `whyStatus` is not `ok`, which keeps the human-driven path aligned with
 * the same acceptance predicate the action enforces.
 */
export function buildCombinedPrompt(violations: Violation[]): string {
  const symbols = violations
    .map((v, i) => {
      const flags: string[] = [];
      if (v.structuralIncomplete) flags.push("STRUCTURE");
      if (v.whyStatus !== "ok") flags.push(`WHY (${v.whyStatus})`);
      const flagSuffix = flags.length ? ` — flags: ${flags.join(", ")}` : "";
      return [
        `### ${i + 1}. \`${v.file}:${v.line}\` — \`${v.symbolName}\` (${v.kind})${flagSuffix}`,
        "",
        "```typescript",
        v.source,
        "```",
      ].join("\n");
    })
    .join("\n\n");

  const instruction = [
    `Generate a TSDoc block for EACH of the ${violations.length} symbols below.`,
    "",
    "Before each block, emit a single-line comment marker in the exact form:",
    "`// <file>:<line> — <symbolName>`",
    "…so the developer can locate the right paste target for every block.",
    "",
    "For symbols flagged `WHY`, you MUST include an `@remarks` block that captures the motivation/constraints/invariants behind the code (the WHY), per the WHY-INFERENCE rules. If the source does not make the why inferable, leave a placeholder remarks of the form `@remarks TODO(author): <one specific question the author must answer>` so the human reviewer knows what's missing.",
    "",
    "Output ONLY the labeled blocks, in the same order as the symbols. No preamble, no trailing commentary.",
  ].join("\n");

  return `${SYSTEM_PROMPT}\n\n---\n\n${instruction}\n\n## Symbols\n\n${symbols}`;
}
