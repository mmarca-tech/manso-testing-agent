import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XrayTestImplementationPack } from "../../domain/xrayTestImplementation/schema.js";
import { renderXrayTestImplementationMarkdown } from "./renderer.js";

export interface WriteXrayTestImplementationResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writeXrayTestImplementationPack(
  pack: XrayTestImplementationPack,
  directory: string,
): Promise<WriteXrayTestImplementationResult> {
  const jsonPath = join(directory, "xray-test-implementation.json");
  const markdownPath = join(directory, "xray-test-implementation.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderXrayTestImplementationMarkdown(pack), "utf8");

  return { directory, jsonPath, markdownPath };
}
