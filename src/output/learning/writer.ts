import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LearningRecordSet } from "../../domain/learningRecord/schema.js";
import { registerCabinArtifacts } from "../../memory/cabin.js";

export interface WriteLearningResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

/**
 * Write a {@link LearningRecordSet} as `learnings.json` + `learnings.md` under
 * `<outDir>/<KEY>/`. This is a generated artifact (durable run memory), not a
 * repo mutation — proposed guideline edits ship as a separate review PR.
 */
export async function writeLearningRecordSet(
  set: LearningRecordSet,
  outDir: string,
): Promise<WriteLearningResult> {
  const directory = join(outDir, sanitizePathSegment(set.issueKey ?? "learnings"));
  const jsonPath = join(directory, "learnings.json");
  const markdownPath = join(directory, "learnings.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(set, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderLearningMarkdown(set), "utf8");
  registerCabinArtifacts({ directory, paths: [jsonPath, markdownPath] });

  return { directory, jsonPath, markdownPath };
}

export function renderLearningMarkdown(set: LearningRecordSet): string {
  const lines: string[] = [];
  lines.push(`# Learnings${set.issueKey ? ` — ${set.issueKey}` : ""}`, "");
  lines.push(`Generated: ${set.generatedAt}`, "");

  const systemic = set.records.filter((r) => r.classification === "systemic");
  const transient = set.records.filter((r) => r.classification === "transient");
  const unknown = set.records.filter((r) => r.classification === "unknown");

  lines.push(
    `Total: ${set.records.length} · systemic: ${systemic.length} · transient: ${transient.length} · unknown: ${unknown.length}`,
    "",
  );

  if (systemic.length > 0) {
    lines.push("## Systemic (proposed guideline edits)", "");
    for (const record of systemic) {
      lines.push(`- **[${record.category}]** ${record.signal}`);
      if (record.proposedChange) {
        lines.push(`  - → \`${record.proposedChange.targetPath}\`: ${record.proposedChange.summary}`);
      }
    }
    lines.push("");
  }

  if (transient.length > 0) {
    lines.push("## Transient (no rule change)", "");
    for (const record of transient) {
      lines.push(`- **[${record.category}]** ${record.signal} — ${record.rationale}`);
    }
    lines.push("");
  }

  if (unknown.length > 0) {
    lines.push("## Unknown (needs human review)", "");
    for (const record of unknown) {
      lines.push(`- ${record.signal}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}
