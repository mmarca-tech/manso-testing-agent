import { join, resolve } from "node:path";
import { loadRuntimeConfig } from "../config/runtimeConfig.js";
import { agentConfigPath, loadAgentConfig, resolveAgentDir } from "../config/agentConfig.js";
import { pathExists } from "../shared/fsUtils.js";
import { vcsTokensFromRuntime } from "../integrations/vcs/resolve.js";
import { withMemoryCabin, type CabinArtifact } from "./cabin.js";

const WORKFLOWS = new Set(["design-tests", "implement-tests", "analyse-coverage", "respond-to-pr",
  "review-pull-request", "generate-release-notes", "analyse-incident"]);

function configuredSecrets(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === "string" && /^(?:.*token|apiKey|.*secret|secretKey|publicKey)$/i.test(key)
      ? [item] : configuredSecrets(item));
}

/** Attach optional cabin only to artifact-generating workflow invocations. */
export async function runWithCliMemory(workflow: string, args: string[], run: () => Promise<number>): Promise<number> {
  if (!WORKFLOWS.has(workflow) || args.includes("--help") || args.includes("-h") || args.includes("--dry-run")) return run();
  const value = (flag: string): string | undefined => {
    const assigned = args.find((arg) => arg.startsWith(`${flag}=`));
    if (assigned) return assigned.slice(flag.length + 1);
    const index = args.indexOf(flag);
    const next = index < 0 ? undefined : args[index + 1];
    return next?.startsWith("-") ? undefined : next;
  };
  const configPath = value("--config");
  const runtime = await loadRuntimeConfig(configPath ? { configPath } : {});
  if (!runtime.memoryCabin) return run();
  const repo = value("--repo");
  const repoRoot = resolve(repo ?? process.env.BUILD_SOURCESDIRECTORY ?? process.cwd());
  const outDir = resolve(value("--out") ?? "out");
  const captureArtifacts: CabinArtifact[] = [];
  // These writers arrive on independent feature branches; do not ingest stale reports.
  const issue = value("--issue");
  const report = workflow === "generate-release-notes" ? "release-notes"
    : workflow === "analyse-incident" ? "incident-analysis" : undefined;
  const pr = value("--pr") ?? process.env.SYSTEM_PULLREQUEST_PULLREQUESTID ?? process.env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER;
  const directories = report && issue
    ? [...new Set([issue, ...(workflow === "analyse-incident" ? [issue.toUpperCase()] : [])])]
      .map((key) => join(outDir, key.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")))
    : workflow === "review-pull-request" && pr && /^[1-9]\d*$/.test(pr) ? [join(outDir, `pr-${pr}`)] : [];
  const basename = report ?? (workflow === "review-pull-request" ? "code-review" : undefined);
  if (basename) for (const directory of directories) {
    captureArtifacts.push({ directory, paths: [join(directory, `${basename}.json`), join(directory, `${basename}.md`)] });
  }
  let redactPatterns: string[] = [];
  if (repoRoot && await pathExists(agentConfigPath(repoRoot, await resolveAgentDir(repoRoot)))) {
    redactPatterns = (await loadAgentConfig(repoRoot)).policy.redactPatterns;
  }
  const secrets = [...configuredSecrets(runtime),
    process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.OTEL_API_KEY,
    process.env.OTEL_SECRET_KEY, process.env.NEW_RELIC_API_KEY].filter((secret): secret is string => Boolean(secret));
  return withMemoryCabin({
    config: runtime.memoryCabin, workflow, outDir, captureArtifacts,
    ...(repoRoot ? { repoRoot } : {}), redactPatterns, secrets, tokens: vcsTokensFromRuntime(runtime),
  }, run);
}
