import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XrayTestDefinitionsPack } from "../../domain/xrayTestDefinitions/schema.js";
import { renderXrayTestDefinitionsMarkdown } from "./renderer.js";

export interface WriteXrayTestDefinitionsResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writeXrayTestDefinitionsPack(
  pack: XrayTestDefinitionsPack,
  directory: string,
): Promise<WriteXrayTestDefinitionsResult> {
  const jsonPath = join(directory, "xray-test-definitions.json");
  const markdownPath = join(directory, "xray-test-definitions.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderXrayTestDefinitionsMarkdown(pack), "utf8");

  return { directory, jsonPath, markdownPath };
}
