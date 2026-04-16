/**
 * A TypeScript file changed in the PR, already fetched from the head ref.
 */
export interface ChangedFile {
  /** Path relative to repo root (e.g. `src/utils/foo.ts`). */
  path: string;
  /** Full source of the file at the PR head SHA. */
  content: string;
}

/**
 * An exported symbol missing (or with incomplete) TSDoc. Raw — no AI output yet.
 */
export interface Violation {
  file: string;
  line: number;
  symbolName: string;
  kind: "function" | "class" | "method" | "interface" | "type-alias";
  /** The symbol's source slice, used as context for the generator. */
  source: string;
  /**
   * The exact content of the file at `line` (1-indexed). The review layer
   * uses this to build a suggestion block that preserves the original line
   * and its indentation beneath the inserted TSDoc.
   */
  originalLine: string;
}

/**
 * A violation plus the Claude-generated TSDoc block, ready to paste above the symbol.
 */
export interface EnrichedViolation extends Violation {
  /** TSDoc block starting with `/**` and ending with `*\/`. */
  tsdoc: string;
}
