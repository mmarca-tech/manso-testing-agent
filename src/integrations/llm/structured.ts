import { z } from "zod";
import { isRecord, parseJsonObject } from "./json.js";
import type { LlmTextClient } from "./types.js";

/**
 * Schema-constrained LLM generation for the design passes (M24).
 *
 * Every design pass used to call `generateText` and parse JSON out of free
 * text; a parse or schema failure warned and skipped — silently losing
 * scenarios. This helper closes that hole from both ends:
 *
 *  1. **Constrain generation** — the pass's Zod contract is converted to JSON
 *     Schema (`z.toJSONSchema`, Zod v4) and sent with the request; providers
 *     that support structured outputs (OpenAI `response_format: json_schema`,
 *     Anthropic forced tool-use) then produce conforming JSON instead of
 *     prose-wrapped guesses. Providers/deployments that don't support it fall
 *     back to plain text generation transparently.
 *  2. **One corrective retry** — if the response still fails to parse or
 *     validate, the model gets ONE re-prompt carrying the exact validation
 *     error before the pass gives up, so a malformed pass gets a second chance
 *     instead of losing output.
 *
 * Failure statistics are counted per process (M24c) so the CLI can report the
 * parse-failure rate and the M23 eval can prove the gain.
 *
 * Provider structured modes require an **object** root. Array-rooted contracts
 * pass an `envelopeKey`: the advertised schema wraps the array in
 * `{ <key>: [...] }`, and the response is accepted in either shape (enveloped
 * or bare array) before validation.
 */

export interface GenerateStructuredInput<S extends z.ZodType> {
  llm: LlmTextClient;
  systemPrompt: string;
  userPrompt: string;
  /** Telemetry label, e.g. "extract-derived-requirements". */
  operation: string;
  /** The pass's validation contract. */
  schema: S;
  /** Short snake_case name for the provider format/tool. */
  schemaName: string;
  /** For array-rooted contracts: the object key wrapping the array. */
  envelopeKey?: string;
  maxOutputTokens?: number;
}

export type GenerateStructuredResult<T> =
  | { ok: true; data: T; attempts: number }
  | { ok: false; stage: "request" | "parse" | "schema"; error: string; attempts: number };

export interface StructuredOutputStats {
  calls: number;
  /** Calls that needed the corrective second attempt. */
  retried: number;
  /** Calls that failed even after the retry. */
  failed: number;
}

const stats: StructuredOutputStats = { calls: 0, retried: 0, failed: 0 };

/** Process-wide counters for the CLI summary (M24c). */
export function getStructuredOutputStats(): StructuredOutputStats {
  return { ...stats };
}

/** Test seam. */
export function resetStructuredOutputStats(): void {
  stats.calls = 0;
  stats.retried = 0;
  stats.failed = 0;
}

/**
 * Convert a pass contract to the JSON Schema advertised to the provider.
 * Best-effort: schemas Zod cannot convert yield `undefined` (plain text mode).
 * Exported for tests.
 */
export function toResponseJsonSchema(
  schema: z.ZodType,
  envelopeKey?: string,
): Record<string, unknown> | undefined {
  let converted: Record<string, unknown>;
  try {
    converted = z.toJSONSchema(schema) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  delete converted.$schema; // provider payloads don't want the meta key
  if (!envelopeKey) return converted;
  return {
    type: "object",
    properties: { [envelopeKey]: converted },
    required: [envelopeKey],
    additionalProperties: false,
  };
}

export async function generateStructured<S extends z.ZodType>(
  input: GenerateStructuredInput<S>,
): Promise<GenerateStructuredResult<z.infer<S>>> {
  stats.calls += 1;
  const responseSchema = toResponseJsonSchema(input.schema, input.envelopeKey);

  let userPrompt = input.userPrompt;
  let lastFailure: { stage: "parse" | "schema"; error: string } | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw: string;
    try {
      raw = await input.llm.generateText({
        systemPrompt: input.systemPrompt,
        userPrompt,
        operation: attempt === 1 ? input.operation : `${input.operation}-retry`,
        ...(responseSchema ? { responseSchema, schemaName: input.schemaName } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      });
    } catch (error) {
      // Transport errors are not retried here — the SDK clients already retry
      // transient failures; a corrective prompt cannot fix a network problem.
      stats.failed += 1;
      return { ok: false, stage: "request", error: errorMessage(error), attempts: attempt };
    }

    let parsed: unknown;
    try {
      parsed = parseJsonObject(raw);
    } catch (error) {
      lastFailure = { stage: "parse", error: `not valid JSON: ${errorMessage(error)}` };
      userPrompt = correctivePrompt(input.userPrompt, raw, lastFailure.error, input.envelopeKey);
      stats.retried += attempt === 1 ? 1 : 0;
      continue;
    }

    // Accept both the enveloped shape (structured mode) and the bare contract
    // shape (plain-text fallback following the original prompt).
    const candidate =
      input.envelopeKey && isRecord(parsed) && input.envelopeKey in parsed
        ? (parsed as Record<string, unknown>)[input.envelopeKey]
        : parsed;

    const result = input.schema.safeParse(candidate);
    if (result.success) {
      return { ok: true, data: result.data, attempts: attempt };
    }

    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    lastFailure = { stage: "schema", error: issues };
    userPrompt = correctivePrompt(input.userPrompt, raw, `schema violations — ${issues}`, input.envelopeKey);
    stats.retried += attempt === 1 ? 1 : 0;
  }

  stats.failed += 1;
  return {
    ok: false,
    stage: lastFailure?.stage ?? "schema",
    error: lastFailure?.error ?? "unknown validation failure",
    attempts: 2,
  };
}

function correctivePrompt(
  originalUserPrompt: string,
  previousResponse: string,
  failure: string,
  envelopeKey?: string,
): string {
  const clipped =
    previousResponse.length > 2000 ? `${previousResponse.slice(0, 2000)}\n...(truncated)` : previousResponse;
  return [
    originalUserPrompt,
    "",
    "--- CORRECTION REQUIRED ---",
    `Your previous response failed validation: ${failure}`,
    "Previous response:",
    clipped,
    "",
    `Respond again with ONLY the corrected JSON${envelopeKey ? ` (a JSON array, or an object under the "${envelopeKey}" key)` : ""}. No prose, no markdown fences.`,
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
