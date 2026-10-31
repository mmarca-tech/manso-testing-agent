/**
 * Secret/PII redaction (M14 governance).
 *
 * A {@link Redactor} scrubs sensitive strings from any text before it leaves
 * the process — telemetry spans, logs, written artifacts, PR comments. It
 * combines a set of always-on built-in patterns (API keys, bearer tokens,
 * private keys, …) with the operator's `policy.redactPatterns` from
 * `.agents/manso.config.json`. Pure and dependency-free.
 */

export const REDACTION_PLACEHOLDER = "[REDACTED]";

/** Always-on patterns for common secret shapes. Conservative to avoid noise. */
const BUILT_IN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, // Anthropic keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi, // bearer tokens
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/g, // basic-auth blobs
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails (PII)
  /(?<=(?:password|passwd|pwd|secret|token|api[_-]?key)["'\s:=]{1,4})[^\s"',]{6,}/gi, // key=value secrets
];

export interface Redactor {
  /** Replace every matched secret/PII span in `text` with the placeholder. */
  redact(text: string): string;
  /** Convenience: redact every string value in a record (shallow). */
  redactRecord(record: Record<string, unknown>): Record<string, unknown>;
  /** Number of patterns this redactor applies (built-in + custom). */
  readonly patternCount: number;
}

/**
 * Build a redactor from custom patterns (treated as regex source strings) plus
 * the built-ins. An invalid custom pattern is skipped (it never throws), so a
 * typo in config cannot crash a run.
 */
export function buildRedactor(customPatterns: string[] = []): Redactor {
  const patterns: RegExp[] = [...BUILT_IN_PATTERNS.map((re) => new RegExp(re.source, re.flags))];
  for (const raw of customPatterns) {
    if (!raw || raw.trim().length === 0) continue;
    try {
      patterns.push(new RegExp(raw, raw === raw.toLowerCase() ? "gi" : "g"));
    } catch {
      // Skip an invalid pattern rather than failing the whole run.
    }
  }

  const redact = (text: string): string => {
    if (!text) return text;
    let output = text;
    for (const pattern of patterns) {
      output = output.replace(pattern, REDACTION_PLACEHOLDER);
    }
    return output;
  };

  return {
    redact,
    redactRecord: (record) =>
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]),
      ),
    patternCount: patterns.length,
  };
}

/** Convenience one-shot for callers that do not hold a Redactor. */
export function redactText(text: string, customPatterns: string[] = []): string {
  return buildRedactor(customPatterns).redact(text);
}

/** Redact nested string values without rewriting JSON syntax or property names. */
export function redactValue(value: unknown, redactor: Redactor): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redactor));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, redactor)]));
  }
  return value;
}
