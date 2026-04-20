// Fixture for the tsdoc-enforcer dogfood PR. Each symbol exercises a
// different branch of the WhyDecision routing. Delete this file after
// the action's behaviour has been observed on the PR.

const RATE_LIMIT_DELAY_MS = 200; // upstream allows at most 5 rps

// `suggest` case: the why is inferable from a nearby named constant with a
// comment that explains the constraint. Claude should emit a full TSDoc
// whose @remarks references the 200ms delay and the upstream rate limit.
/**
 * Fetches a row by its `id`, returning `null` when no matching row exists.
 *
 * @remarks
 * Inserts a delay of {@link RATE_LIMIT_DELAY_MS} before each call because this
 * function is needed for globalisation and general OAF rate-limiting, to ensure
 * the caller does not exceed the allowed request rate.
 *
 * @param id - The identifier of the row to fetch.
 * @returns The matched row as `{ id }`, or `null` when no row exists.
 */
export async function fetchRowById(id: string): Promise<{ id: string } | null> {
  await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
  return { id };
}

// `ask` case: no why-signals visible in the source. Why this function
// trims+lowercases (rather than e.g. NFC-normalises) is a domain decision
// Claude can't infer — it should ask 3-5 targeted questions.
export function applyDomainPolicy(input: string): string {
  return input.trim().toLowerCase();
}

// `skip` case: a trivial type alias whose why genuinely is just a
// restatement of its description. Claude should pick action=skip and the
// review summary should list it as AI-skipped.
export type Severity = "info" | "warn" | "error";

// Mixed case: exported class with a trivial method. Claude's call here is
// less predictable — useful to observe how it routes a borderline symbol.
export class IdentityBox {
  constructor(public readonly value: number) {}
}
