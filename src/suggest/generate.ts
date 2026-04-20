import Anthropic from "@anthropic-ai/sdk";
import * as core from "@actions/core";

import type { Violation } from "../core/types";
import { SYSTEM_PROMPT, buildWhyDecisionMessage } from "../core/prompt";

/**
 * Default model for the suggest variant. Sonnet 4.6 picks the price/quality
 * sweet spot for short structured outputs and is overridable via the
 * `anthropic-model` action input when teams want a faster/cheaper or
 * smarter/more-expensive tradeoff.
 */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

const MAX_TOKENS = 1024;

/**
 * Confidence floor for honoring a `suggest` decision.
 *
 * @remarks
 * Below this threshold we force the decision to `ask` regardless of what the
 * model said it wanted to do. This is the no-bluffing gate from the design
 * doc — it's why the structured output schema includes `confidence` as a
 * required field. Empirically Sonnet self-rates conservatively, so the cap
 * mainly catches cases where the model would otherwise paper over
 * non-inferable invariants with plausible-sounding prose.
 */
const CONFIDENCE_FLOOR = 0.7;

/**
 * Structured output the AI variant routes on. Mirrors the `WhyDecision`
 * union from the plan — `suggest` carries the full TSDoc, `ask` carries
 * targeted questions for the author, `skip` opts out for genuinely trivial
 * symbols.
 */
export type WhyDecision =
  | {
      action: "suggest";
      tsdocFull: string;
      remarksDraft: string;
      confidence: number;
      rationale: string;
      whyExamples?: string[];
    }
  | {
      action: "ask";
      questions: string[];
      confidence: number;
      rationale: string;
      whyExamples?: string[];
    }
  | {
      action: "skip";
      reason: "trivial" | "private-helper" | "pure-restatement";
      confidence: number;
      rationale?: string;
    };

const WHY_DECISION_TOOL: Anthropic.Tool = {
  name: "record_why_decision",
  description:
    "Record your decision for this symbol: suggest a complete TSDoc draft, ask the author to reply with the why, or skip if trivial. When action is 'suggest' or 'ask', provide `whyExamples` — two short plain-English sentences modelling what a good why reply looks like for this symbol.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["suggest", "ask", "skip"],
        description:
          "What to do for this symbol. `suggest` only when the why is inferable from the source.",
      },
      tsdocFull: {
        type: "string",
        description:
          "Full TSDoc block (`/**` … `*/`) including a why-shaped `@remarks`. Required when action='suggest'.",
      },
      remarksDraft: {
        type: "string",
        description:
          "The body of the `@remarks` block alone (without the `@remarks` tag prefix). Required when action='suggest'.",
      },
      questions: {
        type: "array",
        items: { type: "string" },
        description:
          "(Optional, ask branch only.) 2-3 specific questions a senior reviewer might ask. Logged internally for diagnostics; not shown to the author. Leave empty if you have nothing useful.",
      },
      whyExamples: {
        type: "array",
        items: { type: "string" },
        description:
          "EXACTLY TWO short (10-20 word), plain-English examples of what a good 'why' reply from the author might look like for THIS specific symbol — grounded in the source you can see (named constants, nearby error messages, call sites). First person, one sentence each, no TSDoc syntax. These are shown to the author in a collapsed block as inspiration, not as the answer. Required for action='suggest' and action='ask'. Omit for action='skip'.",
      },
      reason: {
        type: "string",
        enum: ["trivial", "private-helper", "pure-restatement"],
        description:
          "Why the symbol is being skipped. Required when action='skip'.",
      },
      confidence: {
        type: "number",
        description:
          "Self-rated confidence in the decision, 0–1. Be honest — values below 0.7 cause `suggest` to be downgraded to `ask`.",
      },
      rationale: {
        type: "string",
        description:
          "One short sentence justifying the decision. Logged for diagnostics.",
      },
    },
    required: ["action", "confidence"],
  },
};

/**
 * Asks Claude to decide what to do for one undocumented symbol.
 *
 * @remarks
 * Sends the static `SYSTEM_PROMPT` as a cached system block (`cache_control:
 * ephemeral`) so subsequent symbols in the same PR run are billed at the
 * cache-read rate rather than re-paying for the full prefix. The volatile
 * per-symbol payload is the user message, which carries the violation's
 * `whyStatus`, `whyFailureReason`, and source slice.
 *
 * Forces the response through the `record_why_decision` tool so the output
 * is structured JSON rather than free-form text — the schema is stable
 * across SDK versions, and parsing is a single `tool_use` block lookup.
 *
 * The `confidence < {@link CONFIDENCE_FLOOR}` clamp downgrades any low-
 * confidence `suggest` to `ask`, preserving the no-bluffing invariant from
 * the design doc.
 *
 * @param args - Anthropic API key, optional model override, and the
 *   {@link Violation} to decide on.
 * @returns The (possibly clamped) {@link WhyDecision} for routing in the
 *   review layer.
 */
export async function decideWhy(args: {
  apiKey: string;
  model?: string;
  violation: Violation;
}): Promise<WhyDecision> {
  const { apiKey, violation } = args;
  const model = args.model || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [WHY_DECISION_TOOL],
      tool_choice: { type: "tool", name: WHY_DECISION_TOOL.name },
      messages: [{ role: "user", content: buildWhyDecisionMessage(violation) }],
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 401) {
      throw new Error(
        "Anthropic API returned 401 — `anthropic-api-key` input is missing or invalid. " +
          "Set it from a workflow secret, e.g. `anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}`.",
      );
    }
    if (status === 429) {
      throw new Error(
        "Anthropic API returned 429 — your org's rate limit is exhausted. " +
          "Retry later, lower `max-symbols-for-ai`, or split the PR.",
      );
    }
    throw err;
  }

  logCacheUsage(response.usage, violation.symbolName);

  const decision = parseDecision(response, violation.symbolName);
  return clampLowConfidence(decision);
}

function parseDecision(
  message: Anthropic.Message,
  symbolName: string,
): WhyDecision {
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error(
      `Claude response for ${symbolName} did not include a tool_use block. ` +
        `Stop reason: ${message.stop_reason}.`,
    );
  }

  const input = toolUse.input as Record<string, unknown>;
  const action = input.action;
  const confidence =
    typeof input.confidence === "number" ? input.confidence : 0;

  if (action === "suggest") {
    const tsdocFull = stringField(input, "tsdocFull");
    const remarksDraft = stringField(input, "remarksDraft");
    if (!tsdocFull || !remarksDraft) {
      // Model said suggest but didn't supply the required fields — treat as
      // ask with a generic prompt rather than crashing the whole run.
      core.warning(
        `Claude action=suggest for ${symbolName} missing tsdocFull/remarksDraft; downgrading to ask.`,
      );
      return {
        action: "ask",
        questions: [
          "What constraint, invariant, or upstream behaviour forced this symbol's current shape?",
          "Are there integration quirks (rate limits, ordering requirements, retries) that future maintainers must preserve?",
        ],
        confidence,
        rationale:
          "Fallback: model returned action=suggest without TSDoc payload.",
      };
    }
    return {
      action: "suggest",
      tsdocFull,
      remarksDraft,
      confidence,
      rationale: stringField(input, "rationale") ?? "",
      whyExamples: stringArrayField(input, "whyExamples"),
    };
  }

  if (action === "ask") {
    // Questions are kept for internal logging only — the author-facing
    // comment no longer renders them, so an empty list is acceptable.
    const questions = Array.isArray(input.questions)
      ? input.questions.filter((q): q is string => typeof q === "string")
      : [];
    return {
      action: "ask",
      questions,
      confidence,
      rationale: stringField(input, "rationale") ?? "",
      whyExamples: stringArrayField(input, "whyExamples"),
    };
  }

  if (action === "skip") {
    const reason = stringField(input, "reason");
    const allowed = ["trivial", "private-helper", "pure-restatement"] as const;
    const validReason = allowed.find((r) => r === reason) ?? "trivial";
    return {
      action: "skip",
      reason: validReason,
      confidence,
      rationale: stringField(input, "rationale"),
    };
  }

  throw new Error(
    `Claude returned unrecognized action='${String(action)}' for ${symbolName}.`,
  );
}

/**
 * Forces a low-confidence `suggest` to become `ask` so the model cannot
 * paper over non-inferable invariants with plausible-sounding prose.
 *
 * @remarks
 * When the downgrade fires we synthesize generic fallback questions because
 * Claude's `ask` payload is on the alternate branch of the union. Logged at
 * info level so we can tell from the run log which symbols got clamped vs
 * which Claude already picked `ask` for.
 */
function clampLowConfidence(d: WhyDecision): WhyDecision {
  if (d.action !== "suggest") return d;
  if (d.confidence >= CONFIDENCE_FLOOR) return d;
  core.info(
    `Confidence ${d.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR} — downgrading suggest to ask.`,
  );
  return {
    action: "ask",
    questions: [
      "What constraint, invariant, or upstream behaviour shaped this symbol?",
      "Are there integration quirks (rate limits, ordering requirements, retries) that future maintainers must preserve?",
      "Why is the current return/error shape what it is — what was the alternative and why was it rejected?",
    ],
    confidence: d.confidence,
    rationale: `Downgraded from suggest (confidence ${d.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR}). Original draft: ${truncate(d.remarksDraft, 120)}`,
  };
}

function stringField(
  o: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function stringArrayField(
  o: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = o[key];
  if (!Array.isArray(v)) return undefined;
  const filtered = v.filter((item): item is string => typeof item === "string");
  return filtered.length > 0 ? filtered : undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function logCacheUsage(usage: Anthropic.Usage, symbolName: string): void {
  // Cache hit/miss reporting helps catch regressions where a prompt edit
  // accidentally invalidates the system-block cache (e.g. dynamic content
  // sneaking in). Logged per call rather than aggregated because the action
  // log is short and per-symbol granularity makes the cause obvious.
  const created = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  if (created > 0 || read > 0) {
    core.info(
      `[${symbolName}] cache_creation=${created} cache_read=${read} input=${usage.input_tokens} output=${usage.output_tokens}`,
    );
  }
}
