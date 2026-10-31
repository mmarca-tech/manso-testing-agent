import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReleaseNotesPackSchema, type ReleaseNotesPack } from "../src/domain/releaseNotes/schema.js";
import { writeReleaseNotesPack } from "../src/output/release-notes/writer.js";

function stubPack(releaseIssueKey: string): ReleaseNotesPack {
  return ReleaseNotesPackSchema.parse({
    schemaVersion: "1.1.0",
    releaseIssueKey,
    notes: {
      title: "October Release",
      audience: "customers",
      summary: "A summary.",
      highlights: [],
      changeItems: [],
      deploymentNotes: [],
      testingNotes: [],
      knownRisks: [],
      ticketSummaries: [],
    },
    releaseMetadata: { contributors: [] },
    teamTemplate: { newFeatures: [], maintenance: [], bugFixes: [] },
    excludedTickets: [],
    linkedTicketKeys: [],
    pullRequestsAnalyzed: 0,
    provenance: { generatedAt: new Date().toISOString(), commentPosted: false },
    warnings: [],
  });
}

describe("writeReleaseNotesPack", () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "manso-relnotes-writer-"));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("keeps pipes and newlines inside one cell of the internal template table", async () => {
    const pack = stubPack("REL-1");
    pack.teamTemplate.bugFixes.push({
      ticketKey: "P-2",
      description: "Login | works\nagain.",
      productAffected: [],
      insufficientContext: false,
    });
    const { markdownPath } = await writeReleaseNotesPack(pack, outDir);
    expect(await readFile(markdownPath, "utf8")).toContain("| Login \\| works again. | P-2 |  |  |");
  });

  it("writes under <outDir>/<ISSUE-KEY>/", async () => {
    const { jsonPath } = await writeReleaseNotesPack(stubPack("REL-1"), outDir);
    expect(relative(outDir, dirname(jsonPath))).toBe("REL-1");
  });

  it.each([".", "..", "../escape", "a/b"])("keeps writes inside outDir for issue key %j", async (key) => {
    const { jsonPath, markdownPath, externalMarkdownPath } = await writeReleaseNotesPack(stubPack(key), outDir);
    for (const path of [jsonPath, markdownPath, externalMarkdownPath]) {
      const rel = relative(outDir, dirname(path));
      expect(rel).not.toBe("");
      expect(rel).not.toBe("..");
      expect(rel.includes("/") || rel.includes("\\")).toBe(false);
    }
  });
});
