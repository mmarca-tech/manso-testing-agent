import type { Attachment } from "../domain/contextPack/schema.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../integrations/llm/types.js";

/**
 * Vision glue for attachment analysis (M10e-2). Kept separate from
 * {@link analyzeAttachments} so the analyzer stays LLM-agnostic and the
 * Researcher decides whether a vision-capable model is available.
 */

const VISION_SYSTEM_PROMPT = [
  "You are a QA analyst extracting testable detail from a product design or screenshot.",
  "Describe what the image shows in a way that helps author acceptance tests:",
  "visible UI elements and their labels, states (enabled/disabled/error), flows implied,",
  "validation messages, and any data or rules shown. Be concise and factual — do not invent",
  "behaviour that is not visible. Output plain prose, no markdown headings.",
].join(" ");

export interface ImageDescriberInput {
  attachment: Attachment;
  data: Uint8Array;
  mimeType: string;
}

/** Build the (pure) multimodal request that asks the model to describe an image. */
export function buildImageAnalysisRequest(input: {
  filename: string;
  mediaType: string;
  dataBase64: string;
  maxOutputTokens?: number;
}): LlmTextGenerationRequest {
  return {
    operation: "describe-attachment-image",
    systemPrompt: VISION_SYSTEM_PROMPT,
    userPrompt: `Describe the attached image "${input.filename}" for test design.`,
    images: [{ mediaType: input.mediaType, dataBase64: input.dataBase64 }],
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
  };
}

/**
 * Adapt an {@link LlmTextClient} into the `describeImage` callback that
 * {@link analyzeAttachments} expects. Returns `undefined` text when the model
 * produced nothing useful, so the analyzer can leave the attachment untouched.
 */
export function createImageDescriber(
  llm: LlmTextClient,
  options: { maxOutputTokens?: number } = {},
): (input: ImageDescriberInput) => Promise<string | undefined> {
  return async ({ attachment, data, mimeType }) => {
    const request = buildImageAnalysisRequest({
      filename: attachment.filename,
      mediaType: mimeType,
      dataBase64: toBase64(data),
      ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    });
    const text = (await llm.generateText(request)).trim();
    return text.length > 0 ? text : undefined;
  };
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}
