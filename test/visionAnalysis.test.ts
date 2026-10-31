import { describe, expect, it } from "vitest";
import { analyzeAttachments } from "../src/context/attachmentAnalysis.js";
import { buildImageAnalysisRequest, createImageDescriber } from "../src/context/visionAnalysis.js";
import { buildAnthropicUserContent } from "../src/integrations/llm/clients/anthropicMessagesClient.js";
import { buildChatUserContent } from "../src/integrations/llm/clients/openAiChatCompletionsClient.js";
import { buildResponsesInput } from "../src/integrations/llm/clients/openAiResponsesClient.js";
import type { Attachment, Warning } from "../src/domain/contextPack/schema.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";

function visionLlm(capture: (req: LlmTextGenerationRequest) => void, reply = "A login form with email and password fields."): LlmTextClient {
  return {
    provider: "openai",
    model: "stub-vision",
    toolName: "stub:vision",
    async generateText(req) {
      capture(req);
      return reply;
    },
  };
}

describe("buildImageAnalysisRequest", () => {
  it("attaches the image and asks for a test-design description", () => {
    const req = buildImageAnalysisRequest({ filename: "login.png", mediaType: "image/png", dataBase64: "AAA" });
    expect(req.operation).toBe("describe-attachment-image");
    expect(req.images).toEqual([{ mediaType: "image/png", dataBase64: "AAA" }]);
    expect(req.userPrompt).toContain("login.png");
  });
});

describe("createImageDescriber", () => {
  it("base64-encodes the bytes and returns the model's description", async () => {
    let captured: LlmTextGenerationRequest | undefined;
    const describe = createImageDescriber(visionLlm((r) => (captured = r)));
    const data = new Uint8Array([1, 2, 3, 4]);
    const text = await describe({ attachment: { filename: "login.png" }, data, mimeType: "image/png" });

    expect(text).toContain("login form");
    expect(captured?.images?.[0]?.dataBase64).toBe(Buffer.from(data).toString("base64"));
    expect(captured?.images?.[0]?.mediaType).toBe("image/png");
  });

  it("returns undefined when the model produces only whitespace", async () => {
    const describe = createImageDescriber(visionLlm(() => undefined, "   "));
    const text = await describe({ attachment: { filename: "x.png" }, data: new Uint8Array([1]), mimeType: "image/png" });
    expect(text).toBeUndefined();
  });
});

describe("analyzeAttachments — vision path", () => {
  it("describes image attachments via the describer with source 'vision'", async () => {
    const warnings: Warning[] = [];
    const attachments: Attachment[] = [{ filename: "login.png", mimeType: "image/png" }];
    const result = await analyzeAttachments({
      attachments,
      warnings,
      fetchContent: async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }),
      describeImage: async () => "Login screen with a Sign in button.",
    });
    expect(result[0]?.analysis).toBe("Login screen with a Sign in button.");
    expect(result[0]?.analysisSource).toBe("vision");
    expect(warnings).toEqual([]);
  });

  it("skips images larger than the byte limit with a warning", async () => {
    const warnings: Warning[] = [];
    const result = await analyzeAttachments({
      attachments: [{ filename: "huge.png", mimeType: "image/png" }],
      warnings,
      maxImageBytes: 4,
      fetchContent: async () => ({ data: new Uint8Array(10), mimeType: "image/png" }),
      describeImage: async () => "should not run",
    });
    expect(result[0]?.analysis).toBeUndefined();
    expect(warnings.some((w) => /huge\.png skipped/.test(w.message))).toBe(true);
  });

  it("caps the number of described images and warns", async () => {
    const warnings: Warning[] = [];
    const attachments: Attachment[] = [
      { filename: "a.png", mimeType: "image/png" },
      { filename: "b.png", mimeType: "image/png" },
      { filename: "c.png", mimeType: "image/png" },
    ];
    const result = await analyzeAttachments({
      attachments,
      warnings,
      maxImages: 1,
      fetchContent: async () => ({ data: new Uint8Array([1]), mimeType: "image/png" }),
      describeImage: async () => "described",
    });
    expect(result.filter((a) => a.analysis).length).toBe(1);
    expect(warnings.some((w) => /Image analysis capped at 1/.test(w.message))).toBe(true);
  });

  it("leaves images untouched when no describer is supplied", async () => {
    const warnings: Warning[] = [];
    const result = await analyzeAttachments({
      attachments: [{ filename: "a.png", mimeType: "image/png" }],
      warnings,
      fetchContent: async () => ({ data: new Uint8Array([1]), mimeType: "image/png" }),
    });
    expect(result[0]?.analysis).toBeUndefined();
  });
});

describe("LLM client multimodal content builders", () => {
  const request: LlmTextGenerationRequest = {
    systemPrompt: "sys",
    userPrompt: "describe this",
    images: [{ mediaType: "image/png", dataBase64: "AAA" }],
  };

  it("Anthropic builds text + image blocks", () => {
    const content = buildAnthropicUserContent(request);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: "text", text: "describe this" });
    expect(blocks[1]).toMatchObject({ type: "image", source: { type: "base64", data: "AAA" } });
  });

  it("Anthropic returns a plain string when there are no images", () => {
    expect(buildAnthropicUserContent({ systemPrompt: "s", userPrompt: "hi" })).toBe("hi");
  });

  it("OpenAI chat builds text + image_url parts", () => {
    const content = buildChatUserContent(request);
    const parts = content as unknown as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "text" });
    expect(parts[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
  });

  it("OpenAI responses builds an input_image part", () => {
    const input = buildResponsesInput(request) as unknown as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0]?.content?.[1]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,AAA" });
  });

  it("OpenAI responses returns a plain string when there are no images", () => {
    expect(buildResponsesInput({ systemPrompt: "s", userPrompt: "hi" })).toBe("hi");
  });
});
