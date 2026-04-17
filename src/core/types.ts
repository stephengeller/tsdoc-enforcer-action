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
 *
 * @remarks
 * A symbol becomes a `Violation` when at least one of `structuralIncomplete`
 * or `whyStatus !== "ok"` is true. Both signals are surfaced because the
 * report comment shows targeted reasons per symbol and the AI variant uses
 * `whyStatus` to decide whether to ask the author for the why.
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
  /**
   * `true` when the structural TSDoc check (description / `@param` /
   * `@returns` presence) fails. See {@link isTsDocIncomplete}.
   */
  structuralIncomplete: boolean;
  /**
   * State of the symbol's `@remarks` block per the why-acceptance predicate
   * in {@link hasAcceptableRemarks}. `"missing"` means the tag is absent;
   * `"weak"` means present but failed a clause; `"ok"` means it passed (and
   * the symbol is in the violations list only because `structuralIncomplete`
   * is true).
   */
  whyStatus: "ok" | "weak" | "missing";
  /**
   * Human-readable explanation of which clause of the why-predicate failed.
   * Undefined when `whyStatus === "ok"`.
   */
  whyFailureReason?: string;
}
