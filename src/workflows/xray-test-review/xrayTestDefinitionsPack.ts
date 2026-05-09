import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContextPack, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import {
  XRAY_TEST_DEFINITIONS_SCHEMA_VERSION,
  XrayTestDefinitionsPackSchema,
  type XrayTestDefinition,
  type XrayTestDefinitionsPack,
} from "../../domain/xrayTestDefinitions/schema.js";

export function defaultXrayTestDefinitionsPath(contextPath: string): string {
  return join(dirname(contextPath), "xray-test-definitions.json");
}

export async function xrayTestDefinitionsPackExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readXrayTestDefinitionsPack(path: string): Promise<XrayTestDefinitionsPack> {
  return XrayTestDefinitionsPackSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function buildXrayTestDefinitionsPack(input: {
  context: ContextPack;
  definitions: XrayTestDefinition[];
  sourceContextPath: string;
  tools?: ToolProvenance[];
  warnings?: Warning[];
  generatedAt?: string;
}): XrayTestDefinitionsPack {
  const pack: XrayTestDefinitionsPack = {
    schemaVersion: XRAY_TEST_DEFINITIONS_SCHEMA_VERSION,
    ticket: {
      key: input.context.ticket.key,
      title: input.context.ticket.title,
      ...(input.context.ticket.url ? { url: input.context.ticket.url } : {}),
    },
    definitions: input.definitions,
    provenance: {
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      sourceContextPath: input.sourceContextPath,
      tools: input.tools ?? [],
    },
    warnings: input.warnings ?? [],
  };

  return XrayTestDefinitionsPackSchema.parse(pack);
}
