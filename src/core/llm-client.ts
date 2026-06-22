import Anthropic from "@anthropic-ai/sdk";

/**
 * The Claude client this action drives.
 *
 * @remarks
 * Both the direct API and the Amazon Bedrock path use the same
 * `@anthropic-ai/sdk` client. Bedrock is reached by pointing `baseURL` at the
 * Bedrock Messages-API endpoint and authenticating with a Bedrock API key
 * (a bearer token) — no second SDK and no AWS request-signing code, so the
 * bundled action stays small. The endpoint speaks the standard Messages API,
 * so `cache_control` and `tool_use` work unchanged.
 */
export type MessagesClient = Anthropic;

/**
 * Default model for the Bedrock path.
 *
 * @remarks
 * The Bedrock Messages-API endpoint does not serve Sonnet 4.6 (that model is
 * only on the older InvokeModel path), so the direct-API default can't carry
 * over. Haiku 4.5 is the cheapest model the endpoint serves and is ample for
 * short per-symbol why-inference; bump `anthropic-model` to
 * `anthropic.claude-opus-4-8` when stronger inference is worth the cost.
 */
export const DEFAULT_BEDROCK_MODEL = "anthropic.claude-haiku-4-5";

/**
 * Builds the Bedrock Messages-API base URL for a region.
 *
 * @remarks
 * The SDK appends `/v1/messages`, so the base URL stops at `/anthropic`.
 *
 * @param region - AWS region, e.g. `us-east-1`.
 * @returns The base URL the Claude client should target.
 */
function bedrockBaseUrl(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws/anthropic`;
}

/**
 * Builds the Claude client from whichever credential the consumer supplied.
 *
 * @remarks
 * Bedrock is preferred when a Bedrock API key is set: inference then runs
 * inside the consumer's own AWS account (their billing, quota, and
 * data-handling boundary), reached with a single long-lived key stored as a
 * workflow secret — no AWS request-signing, IAM role, or OIDC setup. The
 * direct-API path is the no-AWS fallback.
 *
 * @param opts - `bedrockApiKey` + `bedrockRegion` select Bedrock; `apiKey`
 *   selects the direct API. Bedrock wins when its key is present.
 * @returns A configured Claude client.
 */
export function createMessagesClient(opts: {
  apiKey?: string;
  bedrockApiKey?: string;
  bedrockRegion?: string;
}): MessagesClient {
  if (opts.bedrockApiKey) {
    if (!opts.bedrockRegion) {
      throw new Error(
        "`bedrock-region` is required when `bedrock-api-key` is set (it selects the Bedrock endpoint region).",
      );
    }
    return new Anthropic({
      apiKey: opts.bedrockApiKey,
      baseURL: bedrockBaseUrl(opts.bedrockRegion),
    });
  }
  if (opts.apiKey) {
    return new Anthropic({ apiKey: opts.apiKey });
  }
  throw new Error(
    "No Claude credentials configured: set `bedrock-api-key` + `bedrock-region` " +
      "(preferred), or `anthropic-api-key`.",
  );
}
