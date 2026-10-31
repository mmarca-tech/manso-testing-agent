import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  generateStructured,
  getStructuredOutputStats,
  resetStructuredOutputStats,
  toResponseJsonSchema,
} from "../src/integrations/llm/structured.js";
import { extractAnthropicToolInput } from "../src/integrations/llm/clients/anthropicMessagesClient.js";
import { isStructuredOutputRejection } from "../src/integrations/llm/clients/openAiChatCompletionsClient.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";

const Contract = z.object({ items: z.array(z.object({ title: z.string().min(1) })) });
const ArrayContract = z.array(z.object({ id: z.string(), text: z.string() }));

/** Stub client that replays scripted responses and records the requests. */
function stubLlm(responses: Array<string | Error>): { llm: LlmTextClient; requests: LlmTextGenerationRequest[] } {
  const requests: LlmTextGenerationRequest[] = [];
  let call = 0;
  return {
    requests,
    llm: {
      provider: "openai",
      model: "stub",
      toolName: "stub",
      generateText: async (request) => {
        requests.push(request);
        const next = responses[Math.min(call, responses.length - 1)];
        call += 1;
        if (next instanceof Error) throw next;
        return next as string;
      },
    },
  };
}

beforeEach(() => resetStructuredOutputStats());

describe("generateStructured (M24)", () => {
  it("passes the JSON schema + name to the client and returns validated data", async () => {
    const { llm, requests } = stubLlm(['{"items": [{"title": "t1"}]}']);
    const result = await generateStructured({
      llm, systemPrompt: "s", userPrompt: "u", operation: "op", schema: Contract, schemaName: "contract",
    });
    expect(result).toEqual({ ok: true, data: { items: [{ title: "t1" }] }, attempts: 1 });
    expect(requests[0]?.schemaName).toBe("contract");
    expect(requests[0]?.responseSchema).toMatchObject({ type: "object" });
    expect(getStructuredOutputStats()).toEqual({ calls: 1, retried: 0, failed: 0 });
  });

  it("re-prompts ONCE with the validation error, then succeeds", async () => {
    const { llm, requests } = stubLlm(['{"items": [{"title": ""}]}', '{"items": [{"title": "fixed"}]}']);
    const result = await generateStructured({
      llm, systemPrompt: "s", userPrompt: "u", operation: "op", schema: Contract, schemaName: "contract",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
    // The corrective prompt carries the original ask + the exact failure.
    expect(requests[1]?.userPrompt).toContain("CORRECTION REQUIRED");
    expect(requests[1]?.userPrompt).toContain("items.0.title");
    expect(requests[1]?.operation).toBe("op-retry");
    expect(getStructuredOutputStats()).toEqual({ calls: 1, retried: 1, failed: 0 });
  });

  it("retries a non-JSON response and reports parse failures after 2 attempts", async () => {
    const { llm } = stubLlm(["Sure! Here are the items you asked for..."]);
    const result = await generateStructured({
      llm, systemPrompt: "s", userPrompt: "u", operation: "op", schema: Contract, schemaName: "contract",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("parse");
      expect(result.attempts).toBe(2);
    }
    expect(getStructuredOutputStats()).toEqual({ calls: 1, retried: 1, failed: 1 });
  });

  it("does NOT retry transport errors", async () => {
    const { llm, requests } = stubLlm([new Error("socket hang up")]);
    const result = await generateStructured({
      llm, systemPrompt: "s", userPrompt: "u", operation: "op", schema: Contract, schemaName: "contract",
    });
    expect(result).toMatchObject({ ok: false, stage: "request", attempts: 1 });
    expect(requests).toHaveLength(1);
  });

  it("accepts both enveloped and bare shapes for array-rooted contracts", async () => {
    const enveloped = stubLlm(['{"rows": [{"id": "DR-1", "text": "a"}]}']);
    const bare = stubLlm(['[{"id": "DR-1", "text": "a"}]']);
    for (const { llm, requests } of [enveloped, bare]) {
      const result = await generateStructured({
        llm, systemPrompt: "s", userPrompt: "u", operation: "op",
        schema: ArrayContract, schemaName: "rows", envelopeKey: "rows",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toEqual([{ id: "DR-1", text: "a" }]);
      // The advertised schema is the OBJECT envelope (providers require it).
      expect(requests[0]?.responseSchema).toMatchObject({ type: "object", required: ["rows"] });
    }
  });
});

describe("toResponseJsonSchema", () => {
  it("converts a Zod contract and strips the $schema meta key", () => {
    const js = toResponseJsonSchema(Contract);
    expect(js).toMatchObject({ type: "object" });
    expect(js && "$schema" in js).toBe(false);
  });

  it("wraps array-rooted contracts in the envelope", () => {
    const js = toResponseJsonSchema(ArrayContract, "derivedRequirements");
    expect(js).toMatchObject({ type: "object", required: ["derivedRequirements"] });
    expect((js?.properties as Record<string, unknown>)?.derivedRequirements).toMatchObject({ type: "array" });
  });
});

describe("provider structured-output plumbing", () => {
  it("extracts the forced tool call's input from an Anthropic payload", () => {
    const payload = {
      content: [
        { type: "text", text: "calling the tool" },
        { type: "tool_use", name: "contract", input: { items: [{ title: "t" }] } },
      ],
    };
    expect(extractAnthropicToolInput(payload, "contract")).toEqual({ items: [{ title: "t" }] });
    expect(extractAnthropicToolInput(payload, "other")).toBeUndefined();
    expect(extractAnthropicToolInput({ content: "nope" }, "contract")).toBeUndefined();
  });

  it("classifies structured-output rejections for the fallback path", () => {
    expect(isStructuredOutputRejection(new Error("Invalid parameter: 'response_format' of type 'json_schema'"))).toBe(true);
    expect(isStructuredOutputRejection(new Error("unknown field text.format"))).toBe(true);
    expect(isStructuredOutputRejection(new Error("rate limit exceeded"))).toBe(false);
  });
});
