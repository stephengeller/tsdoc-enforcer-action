// Fixture for the tsdoc-enforcer reply-flow dogfood PR. Each symbol
// exercises a different branch of the WhyDecision routing, and the
// reply-to-apply flow is exercised by replying to a few inline comments
// in quick succession. Delete this file after the run is observed.

const RATE_LIMIT_DELAY_MS = 200; // upstream allows at most 5 rps

// `suggest` case: nearby named constant + explanatory comment, so the why
// is inferable. Claude should emit a full TSDoc whose @remarks references
// the 200ms delay and the upstream rate limit.
/**
 * Fetches a row by its `id`, returning `null` when no row exists.
 *
 * @remarks
 * Inserts a delay of {@link RATE_LIMIT_DELAY_MS} before every call because the
 * OAF modulator requires it downstream.
 *
 * @param id - The identifier of the row to fetch.
 * @returns The matching row object, or `null` when the id doesn't exist.
 */
export async function fetchRowById(id: string): Promise<{ id: string } | null> {
  await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
  return { id };
}

// `ask` case: no why-signals visible. Claude should ask 3–5 targeted
// questions; replying to that comment should turn the answer into TSDoc
// via the reply handler.
/**
 * Normalises a domain string by trimming whitespace and converting it to lowercase.
 *
 * @remarks
 * Both `trim` and `toLowerCase` are required because domain comparison logic must
 * perform case-insensitive matching against records stored in lowercase in the database;
 * without this normalisation, lookups against those records would silently fail.
 *
 * @param input - The raw domain string to normalise.
 * @returns The trimmed, lowercased domain string.
 */
export function applyDomainPolicy(input: string): string {
  return input.trim().toLowerCase();
}

// `skip` case: trivial type alias. Claude should pick action=skip; the
// summary should list it as AI-skipped.
export type Severity = "info" | "warn" | "error";

// Borderline: exported class with a trivial constructor. Good for
// exercising the concurrency guard — reply here alongside the other two
// and the workflow's per-PR concurrency group should serialize them.
/**
 * A minimal wrapper that holds a single immutable `number` value.
 *
 * @remarks
 * The author's stated motivation — "Because Smeagol the wise requires it" — is not grounded in
 * anything visible in the source. No constraints, invariants, or integration details are
 * inferable from the code. A best-effort description is provided above; the true WHY should be
 * documented by the author with concrete motivation before this symbol ships.
 *
 * @param value - The numeric value to store in this box.
 */
export class IdentityBox {
  constructor(public readonly value: number) {}
}
