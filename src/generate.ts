import OpenAI from "openai";
import * as core from "@actions/core";

import type { Violation } from "./types";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";

const MODEL = "openai/gpt-4o-mini";
const MAX_TOKENS = 1024;
const BASE_URL = "https://models.github.ai/inference";

/**
 * Asks GitHub Models (gpt-4o-mini) to produce a TSDoc block for a single
 * undocumented symbol.
 *
 * Uses the `GITHUB_TOKEN` already available in the workflow — no extra
 * secret setup required for consumers. Returned string is the raw doc
 * block starting with `/**` and ending with `*\/`, ready to paste
 * directly above the symbol with no post-processing.
 */
export async function generateTsDoc(args: {
  githubToken: string;
  violation: Violation;
}): Promise<string> {
  const { githubToken, violation } = args;
  const client = new OpenAI({ apiKey: githubToken, baseURL: BASE_URL });

  let response;
  try {
    response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(violation) },
      ],
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 403) {
      throw new Error(
        "GitHub Models returned 403 — the org/repo likely hasn't enabled GitHub Models access. " +
          "Ask an org admin to enable GitHub Models, or switch to the AI-free variant at " +
          "stephengeller/tsdoc-enforcer-action/no-ai@v1.",
      );
    }
    if (status === 429) {
      throw new Error(
        "GitHub Models returned 429 — free-tier rate limit hit. Retry later or split the PR.",
      );
    }
    throw err;
  }

  const raw = response.choices[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error(
      `GitHub Models returned no content for ${violation.symbolName}`,
    );
  }

  const block = extractDocBlock(raw);
  if (!block) {
    core.warning(
      `Model output didn't contain a valid TSDoc block for ${violation.symbolName}; using raw output.`,
    );
    return raw;
  }
  return block;
}

/**
 * Finds the first `/** ... *\/` block in the model output. Guards against
 * stray preamble like "Here is the TSDoc:" or code fences wrapping the block.
 */
function extractDocBlock(text: string): string | undefined {
  const match = text.match(/\/\*\*[\s\S]*?\*\//);
  return match?.[0];
}
