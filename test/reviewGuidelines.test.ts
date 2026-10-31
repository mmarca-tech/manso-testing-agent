import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGuidelines } from "../src/agents/pullRequestReviewer/guidelines.js";

describe("readGuidelines", () => {
  let root: string;
  let outside: string;
  let guidelines: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "manso-guidelines-repo-"));
    outside = await mkdtemp(join(tmpdir(), "manso-guidelines-outside-"));
    guidelines = join(root, ".agents", "guidelines");
    await mkdir(guidelines, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "TOP-SECRET-VALUE");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  /** Symlinks need privileges on some Windows setups; skip the test when they cannot be created. */
  async function link(target: string, path: string, type: "file" | "dir" | "junction" = "file"): Promise<boolean> {
    try { await symlink(target, path, type); return true; } catch { return false; }
  }

  it("reads regular Markdown guidelines in name order", async () => {
    await writeFile(join(guidelines, "b.md"), "Second");
    await writeFile(join(guidelines, "a.md"), "First");
    await writeFile(join(guidelines, "ignored.txt"), "Not markdown");
    const result = await readGuidelines(root);
    expect(result.text).toBe("## a.md\nFirst\n## b.md\nSecond");
    expect(result.warnings).toEqual([]);
  });

  it("returns nothing when there is no guidelines directory", async () => {
    await rm(guidelines, { recursive: true });
    expect(await readGuidelines(root)).toEqual({ text: "", warnings: [] });
  });

  it("bounds long files and caps the number of files", async () => {
    await writeFile(join(guidelines, "long.md"), "x".repeat(5000));
    for (let index = 0; index < 9; index++) await writeFile(join(guidelines, `f${index}.md`), "short");
    const result = await readGuidelines(root);
    expect(result.warnings.some((warning) => warning.includes("capped at 8"))).toBe(true);
    expect(result.text).not.toContain("x".repeat(2001));
  });

  it("does not follow a symlinked guideline file", async (context) => {
    if (!await link(join(outside, "secret.txt"), join(guidelines, "leak.md"))) return context.skip();
    await writeFile(join(guidelines, "ok.md"), "Fine");
    const result = await readGuidelines(root);
    expect(result.text).toContain("Fine");
    expect(result.text).not.toContain("TOP-SECRET-VALUE");
    expect(result.warnings.some((warning) => warning.includes("leak.md") && warning.includes("skipped"))).toBe(true);
  });

  it("does not follow a symlinked guidelines directory", async (context) => {
    await rm(guidelines, { recursive: true });
    await writeFile(join(outside, "leak.md"), "TOP-SECRET-VALUE");
    if (!await link(outside, guidelines, "junction")) return context.skip();
    const result = await readGuidelines(root);
    expect(result.text).toBe("");
    expect(result.warnings).toHaveLength(1);
  });
});
