import type { Attachment, Warning } from "../domain/contextPack/schema.js";
import type { AttachmentContent } from "../workflows/ticket-context/ticketSource.js";

/** Coarse kind used to decide how (and whether) to analyze an attachment. */
export type AttachmentKind = "text" | "image" | "pdf" | "other";

const DEFAULT_MAX_ATTACHMENTS = 10;
const DEFAULT_MAX_TEXT_CHARS = 4000;
const DEFAULT_MAX_IMAGES = 6;
const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const TEXT_MIME = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/csv",
  "application/x-ndjson",
  "application/javascript",
]);

const TEXT_EXT = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "feature",
  "log",
  "properties",
  "conf",
  "ini",
  "html",
  "htm",
]);

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tif", "tiff"]);

function extensionOf(filename: string): string {
  const base = filename.split(/[?#]/, 1)[0] ?? filename;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Classify an attachment from its MIME type (preferred) or filename extension. */
export function classifyAttachment(attachment: Attachment): AttachmentKind {
  const mime = attachment.mimeType?.toLowerCase() ?? "";
  const ext = extensionOf(attachment.filename);

  if (mime.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("text/") || TEXT_MIME.has(mime) || TEXT_EXT.has(ext)) return "text";
  return "other";
}

/** Describes an image attachment via a vision model (see visionAnalysis.ts). */
export type DescribeImage = (input: {
  attachment: Attachment;
  data: Uint8Array;
  mimeType: string;
}) => Promise<string | undefined>;

export interface AnalyzeAttachmentsInput {
  attachments: Attachment[];
  /** Downloads attachment bytes; omitted when the provider cannot serve them. */
  fetchContent?: (attachment: Attachment) => Promise<AttachmentContent | undefined>;
  /** Vision describer for image attachments; omitted → images are skipped. */
  describeImage?: DescribeImage;
  /** Collects non-fatal warnings (mirrors the Researcher's pattern). */
  warnings: Warning[];
  /** Max text attachments to analyze (default 10); the rest warn, not drop. */
  maxAttachments?: number;
  /** Per-attachment character cap before visible truncation (default 4000). */
  maxTextChars?: number;
  /** Max image attachments to send to the vision model (default 6). */
  maxImages?: number;
  /** Skip images larger than this many bytes (default 5,000,000). */
  maxImageBytes?: number;
}

/**
 * Enrich attachments with understood content (M10e).
 *
 * Text-like attachments are downloaded and decoded as UTF-8; image attachments
 * are described by the optional vision model (`describeImage`). Results land in
 * `attachment.analysis` with `analysisSource` of "text-extraction" or "vision".
 * Images without a describer (and PDFs/other) are left untouched. Text and
 * image analysis are bounded independently; over-cap, oversize, or
 * undownloadable attachments produce warnings rather than silent loss.
 */
export async function analyzeAttachments(input: AnalyzeAttachmentsInput): Promise<Attachment[]> {
  const { attachments, fetchContent, describeImage, warnings } = input;
  const maxAttachments = input.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  const maxTextChars = input.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxImages = input.maxImages ?? DEFAULT_MAX_IMAGES;
  const maxImageBytes = input.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  const analyzable = attachments.some((attachment) => {
    const kind = classifyAttachment(attachment);
    return kind === "text" || (kind === "image" && Boolean(describeImage));
  });
  if (!fetchContent) {
    if (analyzable) {
      warnings.push({
        section: "attachments",
        message: "Attachment content analysis skipped: the provider cannot download attachment bytes.",
      });
    }
    return attachments;
  }

  let textAnalyzed = 0;
  let imageAnalyzed = 0;
  let skippedText = 0;
  let skippedImages = 0;
  const result: Attachment[] = [];

  for (const attachment of attachments) {
    const kind = classifyAttachment(attachment);

    if (kind === "text") {
      if (textAnalyzed >= maxAttachments) {
        skippedText += 1;
        result.push(attachment);
        continue;
      }
      textAnalyzed += 1;
      try {
        const content = await fetchContent(attachment);
        const text = content ? decodeUtf8(content.data).trim() : "";
        if (!text) {
          result.push(attachment);
          continue;
        }
        const truncated = text.length > maxTextChars ? `${text.slice(0, maxTextChars)}…[truncated]` : text;
        result.push({ ...attachment, analysis: truncated, analysisSource: "text-extraction" });
      } catch (error) {
        warnings.push({
          section: "attachments",
          message: `Could not analyze attachment ${attachment.filename}: ${errorMessage(error)}`,
        });
        result.push(attachment);
      }
      continue;
    }

    if (kind === "image" && describeImage) {
      if (imageAnalyzed >= maxImages) {
        skippedImages += 1;
        result.push(attachment);
        continue;
      }
      imageAnalyzed += 1;
      try {
        const content = await fetchContent(attachment);
        if (!content || content.data.byteLength === 0) {
          result.push(attachment);
          continue;
        }
        if (content.data.byteLength > maxImageBytes) {
          warnings.push({
            section: "attachments",
            message: `Image ${attachment.filename} skipped: ${content.data.byteLength} bytes exceeds the ${maxImageBytes}-byte vision limit.`,
          });
          result.push(attachment);
          continue;
        }
        const mimeType = content.mimeType ?? attachment.mimeType ?? guessImageMime(attachment.filename);
        const description = (await describeImage({ attachment, data: content.data, mimeType }))?.trim();
        if (!description) {
          result.push(attachment);
          continue;
        }
        result.push({ ...attachment, analysis: description, analysisSource: "vision" });
      } catch (error) {
        warnings.push({
          section: "attachments",
          message: `Could not describe image ${attachment.filename}: ${errorMessage(error)}`,
        });
        result.push(attachment);
      }
      continue;
    }

    result.push(attachment);
  }

  if (skippedText > 0) {
    warnings.push({
      section: "attachments",
      message: `Attachment analysis capped at ${maxAttachments}; ${skippedText} text attachment(s) were not analyzed.`,
    });
  }
  if (skippedImages > 0) {
    warnings.push({
      section: "attachments",
      message: `Image analysis capped at ${maxImages}; ${skippedImages} image(s) were not described.`,
    });
  }

  return result;
}

function guessImageMime(filename: string): string {
  return IMAGE_MIME_BY_EXT[extensionOf(filename)] ?? "image/png";
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
