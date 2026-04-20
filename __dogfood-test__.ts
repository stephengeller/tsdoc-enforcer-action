// Fixture for the tsdoc-enforcer dogfood PR. Each symbol exercises a
// different branch of the WhyDecision routing. Delete this file after
// the action's behaviour has been observed on the PR.

const RATE_LIMIT_DELAY_MS = 200; // upstream allows at most 5 rps

// `suggest` case: the why is inferable from a nearby named constant with a
// comment that explains the constraint. Claude should emit a full TSDoc
// whose @remarks references the 200ms delay and the upstream rate limit.
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
