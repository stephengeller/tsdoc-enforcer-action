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
export const SYSTEM_PROMPT = `You are a TSDoc generator for TypeScript code.

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
- Do NOT include @example blocks.
- Do NOT include @throws (not enforced in v1).

CONSTRAINTS
- Do not invent behavior that is not visible in the source.
- If a parameter's purpose is unclear from the source, write a minimal honest description rather than speculating.
- Prefer brevity. A short accurate block is strictly better than a long one that fabricates detail.

EXAMPLE INPUT
\`\`\`typescript
export async function fetchUserById(id: string, client: DbClient): Promise<User | null> {
  const row = await client.query('SELECT * FROM users WHERE id = $1', [id])
  return row ?? null
}
\`\`\`

EXAMPLE OUTPUT
/**
 * Fetches the user with the given id, returning \`null\` when no row exists.
 *
 * @param id - Primary key of the user to fetch.
 * @param client - Database client used to issue the query.
 * @returns The user row, or \`null\` when the id doesn't exist.
 */`;

/**
 * Per-symbol user message. Kept outside the cached system prompt so the
 * system portion can be reused across many symbols in one PR.
 */
export function buildUserMessage(violation: Violation): string {
  return [
    `Generate a TSDoc block for this ${violation.kind} named \`${violation.symbolName}\`.`,
    "",
    "```typescript",
    violation.source,
    "```",
    "",
    "Output ONLY the TSDoc block (starting with `/**` and ending with `*/`). No preamble, no explanation.",
  ].join("\n");
}

/**
 * Returns a fully self-contained prompt the developer can paste into any
 * AI tool (ChatGPT, Claude.ai, Copilot Chat) to regenerate the TSDoc block
 * with identical rules to what the Action enforces.
 *
 * This is what the PR comment surfaces alongside the Action-generated block
 * so devs can tweak or regenerate with extra context if the first pass
 * misses the mark.
 */
export function buildPasteablePrompt(violation: Violation): string {
  return `${SYSTEM_PROMPT}\n\n---\n\n${buildUserMessage(violation)}`;
}

/**
 * Returns a single prompt that asks the AI tool to generate TSDoc blocks
 * for every violation in one pass. Used by the AI-free variant so the
 * developer copy-pastes once instead of per-symbol.
 *
 * The output contract is tightened to include a location label before each
 * block so the developer can find the right target symbol for each result.
 */
export function buildCombinedPrompt(violations: Violation[]): string {
  const symbols = violations
    .map((v, i) => {
      return [
        `### ${i + 1}. \`${v.file}:${v.line}\` — \`${v.symbolName}\` (${v.kind})`,
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
    "Output ONLY the labeled blocks, in the same order as the symbols. No preamble, no trailing commentary.",
  ].join("\n");

  return `${SYSTEM_PROMPT}\n\n---\n\n${instruction}\n\n## Symbols\n\n${symbols}`;
}
