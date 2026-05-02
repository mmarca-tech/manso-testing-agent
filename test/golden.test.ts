import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextPackSchema } from "../src/domain/contextPack/schema.js";
import { renderMarkdown } from "../src/output/context-pack/renderer.js";

const fixtureDir = join(import.meta.dirname, "fixtures");

describe("golden context outputs", () => {
  it("matches the canonical JSON and Markdown fixtures", async () => {
    const json = await readFile(join(fixtureDir, "golden-context.json"), "utf8");
    const markdown = await readFile(join(fixtureDir, "golden-context.md"), "utf8");
    const context = ContextPackSchema.parse(JSON.parse(json));

    expect(`${JSON.stringify(context, null, 2)}\n`).toBe(json);
    expect(renderMarkdown(context)).toBe(markdown);
  });
});
