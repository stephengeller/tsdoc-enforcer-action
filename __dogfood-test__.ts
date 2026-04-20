// Fixture for the tsdoc-enforcer reply-flow dogfood PR. Each symbol
// exercises a different branch of the WhyDecision routing, and the
// reply-to-apply flow is exercised by replying to a few inline comments
// in quick succession. Delete this file after the run is observed.

const RATE_LIMIT_DELAY_MS = 200; // upstream allows at most 5 rps

// `suggest` case: nearby named constant + explanatory comment, so the why
// is inferable. Claude should emit a full TSDoc whose @remarks references
// the 200ms delay and the upstream rate limit.
export async function fetchRowById(id: string): Promise<{ id: string } | null> {
  await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
  return { id };
}

// `ask` case: no why-signals visible. Claude should ask 3–5 targeted
// questions; replying to that comment should turn the answer into TSDoc
// via the reply handler.
export function applyDomainPolicy(input: string): string {
  return input.trim().toLowerCase();
}

// `skip` case: trivial type alias. Claude should pick action=skip; the
// summary should list it as AI-skipped.
export type Severity = "info" | "warn" | "error";

// Borderline: exported class with a trivial constructor. Good for
// exercising the concurrency guard — reply here alongside the other two
// and the workflow's per-PR concurrency group should serialize them.
export class IdentityBox {
  constructor(public readonly value: number) {}
}
