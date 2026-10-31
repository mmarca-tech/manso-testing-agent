import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMemoryCabinConfig, MemoryCabinConfigSchema } from "../src/memory/config.js";
import { registerCabinArtifacts, supplementalCabinContext, withMemoryCabin, type MemoryCabinOptions } from "../src/memory/cabin.js";
import { runWithCliMemory } from "../src/memory/cliSession.js";
import { buildImplementationPrompt } from "../src/agents/implementer/prompts.js";
import { writeLearningRecordSet } from "../src/output/learning/writer.js";
import { writeContextPack } from "../src/output/context-pack/writer.js";
import { writeTestDesignPack } from "../src/output/test-design/writer.js";
import { buildAcExtractionPrompt, buildGherkinDesignPrompt, buildPlainEnglishDesignPrompt } from "../src/agents/testArchitect/prompts.js";
import type { VcsAdapter, VcsRaisePullRequestResult } from "../src/integrations/vcs/adapter.js";
import type { ContextPack } from "../src/domain/contextPack/schema.js";
import type { TestDesignPack } from "../src/domain/testDesignPack/schema.js";

let work: string;
let cabin: string;
let source: string;
let out: string;
let warnings: ReturnType<typeof vi.spyOn>;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.longpaths=true", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function options(extra: Partial<MemoryCabinOptions> = {}): MemoryCabinOptions {
  return {
    config: MemoryCabinConfigSchema.parse({ enabled: true, root: cabin, strict: true }),
    workflow: "design-tests", outDir: out, ...extra,
  };
}
async function artifacts(text = "Historical report"): Promise<void> {
  const path = join(source, "report.md");
  await writeFile(path, text);
  registerCabinArtifacts({ directory: source, paths: [path] });
}
async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}
async function initRemote(): Promise<string> {
  const seed = join(work, "seed");
  const remote = join(work, "remote.git");
  await mkdir(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.invalid");
  await mkdir(join(seed, "knowledge"));
  await writeFile(join(seed, "knowledge", "shared.md"), "Shared cross-repo knowledge");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "Initial knowledge");
  git(work, "init", "--bare", remote);
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main");
  return remote;
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "manso-memory-"));
  cabin = join(work, "cabin");
  source = join(work, "out", "RM-123");
  out = join(work, "out");
  await mkdir(source, { recursive: true });
  warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  for (const key of ["ENABLED", "ROOT", "STRICT", "READ_CONTEXT", "CACHE_DIR", "BRANCH"]) vi.stubEnv(`MANSO_MEMORY_${key}`, "");
  vi.stubEnv("MANSO_AUDIT_LOG", "");
});
afterEach(async () => {
  warnings.mockRestore();
  vi.unstubAllEnvs();
  await rm(work, { recursive: true, force: true });
});

describe("optional cabin configuration", () => {
  it("is disabled even when a root is set without explicit opt-in", () => {
    vi.stubEnv("MANSO_MEMORY_ROOT", cabin);
    expect(loadMemoryCabinConfig().enabled).toBe(false);
  });
  it("supports runtime configuration and explicit environment overrides", () => {
    vi.stubEnv("MANSO_MEMORY_ENABLED", "true");
    vi.stubEnv("MANSO_MEMORY_ROOT", cabin);
    vi.stubEnv("MANSO_MEMORY_STRICT", "false");
    const config = loadMemoryCabinConfig({ root: "other", strict: true, readContext: false });
    expect(config).toMatchObject({ enabled: true, root: cabin, strict: false, readContext: false });
  });
  it("requires a root when enabled", () => {
    expect(() => loadMemoryCabinConfig({ enabled: true })).toThrow("requires");
  });
  it.each([["yes", true], ["1", true], ["ON", true], ["TRUE", true], ["False", false], ["0", false], ["no", false], ["off", false]])(
    "accepts the usual boolean spelling %s", (value, expected) => {
      vi.stubEnv("MANSO_MEMORY_ENABLED", value);
      vi.stubEnv("MANSO_MEMORY_ROOT", cabin);
      expect(loadMemoryCabinConfig().enabled).toBe(expected);
    });
  it.each(["invalid", "2", "enabled"])("warns and stays disabled for unrecognised enabled flag %s instead of blocking commands", (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("MANSO_MEMORY_ENABLED", value);
    vi.stubEnv("MANSO_MEMORY_ROOT", cabin);
    expect(loadMemoryCabinConfig().enabled).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MANSO_MEMORY_ENABLED"));
    warn.mockRestore();
  });
  it("warns and stays disabled for an invalid configuration that never enabled the cabin", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("MANSO_MEMORY_STRICT", "sometimes");
    vi.stubEnv("MANSO_MEMORY_BRANCH", "unmapped-branch-warning");
    expect(loadMemoryCabinConfig({ maxContextChars: 16001 }).enabled).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it("still fails loudly when the cabin was explicitly enabled and is misconfigured", () => {
    vi.stubEnv("MANSO_MEMORY_ENABLED", "true");
    vi.stubEnv("MANSO_MEMORY_ROOT", cabin);
    vi.stubEnv("MANSO_MEMORY_STRICT", "sometimes");
    expect(() => loadMemoryCabinConfig()).toThrow("MANSO_MEMORY_STRICT");
    vi.unstubAllEnvs();
    expect(() => loadMemoryCabinConfig({ enabled: true, maxContextChars: 16001 })).toThrow("invalid");
  });
  it("treats an unmapped pipeline variable as unset", () => {
    vi.stubEnv("MANSO_MEMORY_ENABLED", "$(MANSO_MEMORY_ENABLED)");
    vi.stubEnv("MANSO_MEMORY_ROOT", "$(MANSO_MEMORY_ROOT)");
    expect(loadMemoryCabinConfig({ enabled: true, root: cabin })).toMatchObject({ enabled: true, root: cabin });
  });
  it("bounds context and rejects unknown config keys", () => {
    expect(() => MemoryCabinConfigSchema.parse({ maxContextChars: 16001 })).toThrow();
    expect(() => MemoryCabinConfigSchema.parse({ typo: true })).toThrow();
  });
});

describe("isolated durable history", () => {
  it("performs no cabin or audit I/O when disabled", async () => {
    const result = await withMemoryCabin(options({ config: MemoryCabinConfigSchema.parse({ root: cabin }) }), async () => {
      await artifacts();
      expect(supplementalCabinContext()).toBe("");
      return 42;
    });
    expect(result).toBe(42);
    await expect(stat(cabin)).rejects.toThrow();
    await expect(stat(join(out, "audit.jsonl"))).rejects.toThrow();
  });
  it("suppresses all cabin reads/writes for dry run", async () => {
    await withMemoryCabin(options({ dryRun: true }), artifacts);
    await expect(stat(cabin)).rejects.toThrow();
  });
  it("isolates an explicitly disabled nested workflow from an enabled parent", async () => {
    await mkdir(join(cabin, "knowledge"), { recursive: true });
    await writeFile(join(cabin, "knowledge", "shared.md"), "Parent knowledge");
    await withMemoryCabin(options(), async () => {
      expect(supplementalCabinContext()).toContain("Parent knowledge");
      await withMemoryCabin(options({ config: MemoryCabinConfigSchema.parse({ enabled: false }) }), async () => {
        expect(supplementalCabinContext()).toBe("");
        await artifacts("Do not mirror");
      });
      expect(supplementalCabinContext()).toContain("Parent knowledge");
    });
    expect((await files(cabin)).some((path) => path.endsWith("report.md"))).toBe(false);
  });
  it("records timestamped runs and replaces only the latest workflow snapshot", async () => {
    await withMemoryCabin(options(), () => artifacts("First"));
    await withMemoryCabin(options(), () => artifacts("Second"));
    const paths = await files(cabin);
    const reports = paths.filter((path) => path.endsWith("report.md"));
    expect(reports).toHaveLength(3);
    const latest = reports.find((path) => path.includes("latest"));
    expect(await readFile(latest!, "utf8")).toBe("Second");
    const runs = reports.filter((path) => path.includes("runs"));
    expect(await Promise.all(runs.map((path) => readFile(path, "utf8")))).toEqual(expect.arrayContaining(["First", "Second"]));
    const manifest = JSON.parse(await readFile(join(latest!, "..", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schemaVersion: "1.0.0", workflow: "design-tests", failed: false });
    expect(manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain(source);
    const audit = await readFile(join(out, "audit.jsonl"), "utf8");
    expect(audit).toContain('"phase":"completed"');
    expect(audit).toContain('"delivery":"filesystem"');
  });
  it("preserves nested features and isolates different workflows", async () => {
    await mkdir(join(source, "features"));
    const feature = join(source, "features", "scenario.feature");
    await writeFile(feature, "Feature: Example");
    await withMemoryCabin(options(), async () => registerCabinArtifacts({ directory: source, paths: [feature] }));
    await withMemoryCabin(options({ workflow: "implement-tests" }), artifacts);
    const paths = await files(cabin);
    expect(paths.filter((path) => path.endsWith("scenario.feature"))).toHaveLength(2);
    expect(paths.filter((path) => path.includes("manifest.json"))).toHaveLength(4);
  });
  it("scrubs nested JSON values, keys, markdown, custom patterns and exact credentials", async () => {
    const json = join(source, "report.json");
    await writeFile(json, JSON.stringify({ nested: [{ email: "person@example.com", secret: "arbitrary-private-key-value",
      custom: "IBAN-12345" }], "person@example.com": "value" }));
    await withMemoryCabin(options({ secrets: ["arbitrary-private-key-value"], redactPatterns: ["IBAN-\\d+"] }), async () => {
      registerCabinArtifacts({ directory: source, paths: [json] });
      await artifacts("person@example.com Bearer abcdefghijklmnopqrst");
    });
    for (const path of (await files(cabin)).filter((path) => !path.endsWith("manifest.json"))) {
      const text = await readFile(path, "utf8");
      expect(text).not.toMatch(/person@example\.com|arbitrary-private-key-value|IBAN-12345|abcdefghijklmnopqrst/);
      expect(text).toContain("[REDACTED]");
      if (path.endsWith(".json")) expect(() => JSON.parse(text)).not.toThrow();
    }
  });
  it("archives generated artifacts on workflow failure and propagates its original error", async () => {
    await expect(withMemoryCabin(options(), async () => { await artifacts(); throw new Error("Workflow failed"); }))
      .rejects.toThrow("Workflow failed");
    const manifest = (await files(cabin)).find((path) => path.includes("latest") && path.endsWith("manifest.json"));
    expect(JSON.parse(await readFile(manifest!, "utf8")).failed).toBe(true);
  });
  it("recognizes nonzero CLI exit as a failed run", async () => {
    expect(await withMemoryCabin(options(), async () => { await artifacts(); return 1; })).toBe(1);
    const manifest = (await files(cabin)).find((path) => path.endsWith("manifest.json"));
    expect(JSON.parse(await readFile(manifest!, "utf8")).failed).toBe(true);
  });
  it("registers standard writer output without changing local learnings", async () => {
    await withMemoryCabin(options(), async () => {
      await writeLearningRecordSet({ schemaVersion: "1.0.0", issueKey: "RM-123", generatedAt: new Date().toISOString(), records: [] }, out);
    });
    const paths = await files(cabin);
    expect(paths.filter((path) => path.endsWith("learnings.json"))).toHaveLength(2);
    await expect(stat(join(work, ".agents", "memory"))).rejects.toThrow();
  });
  it("rejects artifact escape and does not ingest unrelated output files", async () => {
    const unrelated = join(out, "runtime-secrets.json");
    await writeFile(unrelated, '{"secret":"not-uploaded"}');
    await expect(withMemoryCabin(options(), async () => registerCabinArtifacts({ directory: source, paths: [unrelated] })))
      .rejects.toThrow("escapes");
    expect((await files(cabin)).filter((path) => path.endsWith(".json"))).toEqual([]);
  });
  it.each(["bad.json", "raw.exe", "binary.md"])("rejects invalid artifact %s before any mirror write", async (name) => {
    const path = join(source, name);
    await writeFile(path, name === "binary.md" ? Buffer.from([0, 1, 2]) : "invalid");
    await expect(withMemoryCabin(options(), async () => registerCabinArtifacts({ directory: source, paths: [path] })))
      .rejects.toThrow();
    expect(await files(cabin)).toEqual([]);
  });
  it("rejects oversized artifacts", async () => {
    const path = join(source, "large.md");
    await writeFile(path, "x".repeat(2 * 1024 * 1024 + 1));
    await expect(withMemoryCabin(options(), async () => registerCabinArtifacts({ directory: source, paths: [path] })))
      .rejects.toThrow("2 MiB");
  });
  it("rejects a cabin inside the target repository", async () => {
    await expect(withMemoryCabin(options({ repoRoot: work }), artifacts)).rejects.toThrow("inside the target");
    await expect(stat(cabin)).rejects.toThrow();
  });
  it("fails closed on invalid redaction patterns", async () => {
    await expect(withMemoryCabin(options({ redactPatterns: ["["] }), artifacts)).rejects.toThrow("redaction pattern");
  });
  it("keeps identically named scope directories separate within one run", async () => {
    const other = join(out, "nested", "RM-123");
    await mkdir(other, { recursive: true });
    const path = join(other, "report.md");
    await writeFile(path, "Other scope");
    await withMemoryCabin(options(), async () => {
      await artifacts();
      registerCabinArtifacts({ directory: other, paths: [path] });
    });
    expect((await files(cabin)).filter((path) => path.endsWith("report.md"))).toHaveLength(4);
  });
  it("separates repositories and supports a target checkout with no origin", async () => {
    const first = join(work, "repo-one");
    const second = join(work, "repo-two");
    await mkdir(first);
    await mkdir(second);
    git(first, "init");
    git(second, "init");
    await withMemoryCabin(options({ repoRoot: first }), artifacts);
    await withMemoryCabin(options({ repoRoot: second }), artifacts);
    expect(await readdir(join(cabin, "artifacts"))).toHaveLength(2);
  });
  it("rejects source directory junctions without copying their files", async () => {
    const alias = join(work, "source-alias");
    await symlink(source, alias, "junction");
    await expect(withMemoryCabin(options(), async () => {
      await artifacts();
      registerCabinArtifacts({ directory: alias, paths: [join(alias, "report.md")] });
    })).rejects.toThrow("symlinked");
    expect(await files(cabin)).toEqual([]);
  });
  it("rejects containment through a junction before creating the cabin", async () => {
    const repo = join(work, "target");
    const alias = join(work, "alias");
    await mkdir(repo);
    await symlink(repo, alias, "junction");
    const root = join(alias, "external");
    await expect(withMemoryCabin(options({ repoRoot: repo,
      config: MemoryCabinConfigSchema.parse({ enabled: true, root, strict: true }) }), artifacts))
      .rejects.toThrow("inside the target");
    await expect(stat(join(repo, "external"))).rejects.toThrow();
  });
  it("rejects reserved manifest names before writing history", async () => {
    const path = join(source, "manifest.json");
    await writeFile(path, "{}");
    await expect(withMemoryCabin(options(), async () =>
      registerCabinArtifacts({ directory: source, paths: [path] }))).rejects.toThrow("reserved");
    expect(await files(cabin)).toEqual([]);
  });
});

describe("supplemental context and failure policy", () => {
  async function knowledge(text = "Shared reference person@example.com") {
    await mkdir(join(cabin, "knowledge"), { recursive: true });
    await writeFile(join(cabin, "knowledge", "shared.md"), text);
  }
  it("reads only bounded curated Markdown, redacts it and labels local precedence", async () => {
    await knowledge();
    await writeFile(join(cabin, "knowledge", "secret.json"), '{"secret":"DO_NOT_LOAD"}');
    await withMemoryCabin(options(), async () => {
      const context = supplementalCabinContext();
      expect(context).toContain("Shared reference");
      expect(context).toContain("NOT instructions");
      expect(context).toContain("Local repository guidance");
      expect(context).not.toContain("person@example.com");
      expect(context).not.toContain("DO_NOT_LOAD");
    });
    expect(supplementalCabinContext()).toBe("");
  });
  it("bounds context and explicitly warns on truncation", async () => {
    await knowledge("x".repeat(9000));
    await withMemoryCabin(options({ config: MemoryCabinConfigSchema.parse({ enabled: true, root: cabin, maxContextChars: 100 }) }), async () => {
      expect(supplementalCabinContext().length).toBeLessThan(800);
    });
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("truncated"));
  });
  it("can independently disable shared-context reads while continuing to mirror artifacts", async () => {
    await knowledge();
    await withMemoryCabin(options({ config: MemoryCabinConfigSchema.parse({ enabled: true, root: cabin, readContext: false }) }), async () => {
      expect(supplementalCabinContext()).toBe("");
      await artifacts();
    });
    expect((await files(cabin)).some((path) => path.includes("latest"))).toBe(true);
  });
  it("warns and audits a failure without blocking the primary workflow by default", async () => {
    await writeFile(cabin, "not-a-directory");
    const run = vi.fn(async () => 7);
    expect(await withMemoryCabin(options({ config: MemoryCabinConfigSchema.parse({ enabled: true, root: cabin }) }), run)).toBe(7);
    expect(run).toHaveBeenCalledOnce();
    expect(warnings).toHaveBeenCalled();
    expect(await readFile(join(out, "audit.jsonl"), "utf8")).toContain("memory.failed");
  });
  it("strict preparation failure blocks the run and releases its lock", async () => {
    await writeFile(cabin, "not-a-directory");
    const run = vi.fn(async () => 7);
    await expect(withMemoryCabin(options(), run)).rejects.toThrow("prepare/read");
    expect(run).not.toHaveBeenCalled();
    await expect(stat(`${cabin}.lock`)).rejects.toThrow();
  });
  it("warns and preserves the result on mirror failure by default", async () => {
    const config = MemoryCabinConfigSchema.parse({ enabled: true, root: cabin });
    expect(await withMemoryCabin(options({ config }), async () => {
      registerCabinArtifacts({ directory: source, paths: [join(source, "missing.md")] });
      return 0;
    })).toBe(0);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("mirror"));
    expect(await readFile(join(out, "audit.jsonl"), "utf8")).toContain("memory.failed");
  });
  it("preserves both workflow and strict mirror errors", async () => {
    const failure = new Error("Original workflow failure");
    await expect(withMemoryCabin(options(), async () => {
      registerCabinArtifacts({ directory: source, paths: [join(source, "missing.md")] });
      throw failure;
    })).rejects.toMatchObject({
      name: "AggregateError", errors: [failure, expect.objectContaining({ message: expect.stringContaining("mirror") })],
    });
    await expect(stat(`${cabin}.lock`)).rejects.toThrow();
  });
  it("keeps the original workflow error when optional mirroring also fails", async () => {
    const failure = new Error("Original workflow failure");
    const config = MemoryCabinConfigSchema.parse({ enabled: true, root: cabin });
    await expect(withMemoryCabin(options({ config }), async () => {
      registerCabinArtifacts({ directory: source, paths: [join(source, "missing.md")] });
      throw failure;
    })).rejects.toBe(failure);
  });
  it("fails visibly and does not write artifacts when audit persistence fails", async () => {
    vi.stubEnv("MANSO_AUDIT_LOG", source);
    await expect(withMemoryCabin(options(), artifacts)).rejects.toThrow("mirror");
    expect(await files(cabin)).toEqual([]);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Failed to persist"));
  });
  it("rejects symlinked knowledge and redacts knowledge filenames", async () => {
    const external = join(work, "external");
    await mkdir(external);
    await mkdir(cabin);
    await symlink(external, join(cabin, "knowledge"), "junction");
    await expect(withMemoryCabin(options(), artifacts)).rejects.toThrow("symlinks");
    await rm(join(cabin, "knowledge"));
    await mkdir(join(cabin, "knowledge"));
    await writeFile(join(cabin, "knowledge", "person@example.com.md"), "Reference");
    await withMemoryCabin(options(), async () => {
      expect(supplementalCabinContext()).not.toContain("person@example.com");
    });
  });
  it("rejects concurrent sessions without stealing the existing lock", async () => {
    await writeFile(`${cabin}.lock`, "existing-owner");
    await expect(withMemoryCabin(options(), artifacts)).rejects.toThrow("prepare/read");
    expect(await readFile(`${cabin}.lock`, "utf8")).toBe("existing-owner");
  });
  it("serializes real concurrent run access using an exclusive lock", async () => {
    let release!: () => void;
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = withMemoryCabin(options(), async () => { ready(); await wait; await artifacts("First"); });
    await entered;
    await expect(withMemoryCabin(options(), artifacts)).rejects.toThrow("prepare/read");
    release();
    await first;
    await expect(stat(`${cabin}.lock`)).rejects.toThrow();
  });
  it("warns rather than failing a successful workflow when optional lock cleanup fails", async () => {
    const config = MemoryCabinConfigSchema.parse({ enabled: true, root: cabin });
    expect(await withMemoryCabin(options({ config }), async () => {
      await rm(`${cabin}.lock`);
      await mkdir(`${cabin}.lock`);
      return 0;
    })).toBe(0);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("lock cleanup"));
  });
  it("rejects embedded HTTPS credentials without logging them", async () => {
    const secret = "private-value-that-must-not-log";
    await expect(withMemoryCabin(options({ config: MemoryCabinConfigSchema.parse({
      enabled: true, root: `https://user:${secret}@example.invalid/repo`, strict: true,
    }) }), artifacts)).rejects.toThrow("without embedded");
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(secret);
  });
  it("feeds historical context into implementation and design prompts, never requirement extraction", async () => {
    await knowledge("Reuse schema contracts after checking local YAML");
    const design: TestDesignPack = {
      schemaVersion: "1.0.0", ticket: { key: "RM-123", title: "Example" }, outputMode: "gherkin",
      scenarios: [], acceptanceCriteria: [], strategySummary: "", coverageGaps: [], acCoverageMatrix: [],
      riskRanking: [], openQuestions: [], warnings: [],
      provenance: { generatedAt: new Date().toISOString(), issueKey: "RM-123", llm: { provider: "anthropic", model: "stub" }, tools: [] },
    };
    const context: ContextPack = {
      schemaVersion: "1.0.0", ticket: { key: "RM-123", title: "Example", labels: [], components: [], links: [] },
      description: { format: "text", text: "" }, comments: [], confluencePages: [], xrayTestCases: [],
      attachments: [], warnings: [], relatedTickets: [], development: { branches: [], pullRequests: [] },
      provenance: { generatedAt: new Date().toISOString(), issueKey: "RM-123", source: "jira-rest", tools: [] },
    };
    await withMemoryCabin(options(), async () => {
      const implementation = buildImplementationPrompt({ testDesign: design, repoRoot: work,
        stack: { id: "test", root: ".", verifyCommand: "npm test" },
        bindingSkill: { name: "test", description: "Test skill", body: "Local rules", source: "packaged", path: "test" },
        guidanceFiles: [], featurePaths: [] });
      // The implementer can run commands and write files, so shared knowledge stays out of its prompt.
      expect(implementation).not.toContain("Reuse schema contracts");
      expect(implementation).toContain("Local rules");
      for (const build of [buildGherkinDesignPrompt, buildPlainEnglishDesignPrompt]) {
        expect(build({ context, acceptanceCriteria: [], skillBody: "" }).userPrompt).toContain("Reuse schema contracts");
      }
      expect(buildAcExtractionPrompt({ context, skillBody: "" }).userPrompt).not.toContain("Reuse schema contracts");
      await writeContextPack(context, out);
      await writeTestDesignPack(design, out);
    });
    expect((await files(cabin)).filter((path) => path.endsWith("context.json"))).toHaveLength(2);
    expect((await files(cabin)).filter((path) => path.endsWith("test-design.json"))).toHaveLength(2);
  });
});

describe("git-backed memory and PR fallback", () => {
  it("fetches shared knowledge and pushes redacted history to the configured memory branch", async () => {
    const remote = await initRemote();
    const config = MemoryCabinConfigSchema.parse({ enabled: true, root: pathToFileURL(remote).href,
      cacheDir: join(work, "cache"), strict: true });
    await withMemoryCabin(options({ config, secrets: ["opaque-private-credential"] }), async () => {
      expect(supplementalCabinContext()).toContain("Shared cross-repo knowledge");
      await artifacts("Stored once opaque-private-credential");
    });
    expect(git(work, "--git-dir", remote, "log", "main", "-1", "--format=%s")).toContain("Memory history");
    const seed = join(work, "seed");
    git(seed, "pull", "--ff-only", "origin", "main");
    await writeFile(join(seed, "knowledge", "shared.md"), "Updated cross-repo knowledge");
    git(seed, "add", "knowledge");
    git(seed, "commit", "-m", "Refresh curated knowledge");
    git(seed, "push", "origin", "main");
    await withMemoryCabin(options({ config }), async () => {
      expect(supplementalCabinContext()).toContain("Updated cross-repo knowledge");
      await artifacts("Stored twice");
    });
    const clone = join(work, "inspect");
    git(work, "clone", "--branch", "main", remote, clone);
    const reports = (await files(join(clone, "artifacts"))).filter((path) => path.endsWith("report.md"));
    expect(reports).toHaveLength(3);
    expect((await Promise.all(reports.map((path) => readFile(path, "utf8")))).join("\n"))
      .not.toContain("opaque-private-credential");
  });
  it("refuses dirty local cabin checkouts and leaves unrelated files unstaged", async () => {
    const remote = await initRemote();
    git(work, "clone", "--branch", "main", remote, cabin);
    await writeFile(join(cabin, "unrelated.md"), "Do not commit");
    await expect(withMemoryCabin(options(), artifacts)).rejects.toThrow("dirty");
    expect(git(cabin, "status", "--porcelain")).toBe("?? unrelated.md");
  });
  it("opens a fallback PR only after direct push is rejected", async () => {
    const remote = await initRemote();
    // Reject only main writes; allow isolated history branches.
    await writeFile(join(remote, "hooks", "pre-receive"), '#!/bin/sh\nwhile read old new ref; do\nif [ "$ref" = "refs/heads/main" ]; then exit 1; fi\ndone\nexit 0\n', { mode: 0o755 });
    const adapter: VcsAdapter = { kind: "azure-devops", raisePullRequest: vi.fn(async (): Promise<VcsRaisePullRequestResult> => ({ status: "raised", pullRequestId: 1 })) };
    const config = MemoryCabinConfigSchema.parse({ enabled: true, root: pathToFileURL(remote).href,
      cacheDir: join(work, "cache"), strict: true });
    await withMemoryCabin(options({ config, adapter }), artifacts);
    expect(adapter.raisePullRequest).toHaveBeenCalledWith(expect.objectContaining({
      targetBranch: "main", branch: expect.stringMatching(/^manso-memory\//),
    }));
    expect(git(work, "--git-dir", remote, "branch")).toContain("manso-memory/");
    expect(await readFile(join(out, "audit.jsonl"), "utf8")).toContain('"delivery":"pull-request"');
  });
  it("reports rejected push with no PR credentials as failure rather than success", async () => {
    const remote = await initRemote();
    await writeFile(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const config = MemoryCabinConfigSchema.parse({ enabled: true, root: pathToFileURL(remote).href,
      cacheDir: join(work, "cache"), strict: true });
    await expect(withMemoryCabin(options({ config }), artifacts)).rejects.toThrow("PR fallback requires");
    const audit = await readFile(join(out, "audit.jsonl"), "utf8");
    expect(audit).toContain("memory.failed");
    expect(audit).not.toContain('"phase":"completed"');
  });
  it("does not claim a successful delivery when fallback PR creation fails", async () => {
    const remote = await initRemote();
    await writeFile(join(remote, "hooks", "pre-receive"), '#!/bin/sh\nwhile read old new ref; do\nif [ "$ref" = "refs/heads/main" ]; then exit 1; fi\ndone\nexit 0\n', { mode: 0o755 });
    const adapter: VcsAdapter = { kind: "azure-devops",
      raisePullRequest: async () => ({ status: "failed", reason: "Test failure" }) };
    const config = MemoryCabinConfigSchema.parse({ enabled: true, root: pathToFileURL(remote).href,
      cacheDir: join(work, "cache"), strict: true });
    await expect(withMemoryCabin(options({ config, adapter }), artifacts)).rejects.toThrow("fallback PR");
    expect(await readFile(join(out, "audit.jsonl"), "utf8")).not.toContain('"phase":"completed"');
  });
});

describe("CLI cabin wrapper", () => {
  it("does not activate for help, dry runs or non-workflow commands", async () => {
    vi.stubEnv("MANSO_MEMORY_ENABLED", "true");
    vi.stubEnv("MANSO_MEMORY_ROOT", cabin);
    for (const [verb, args] of [["init", []], ["design-tests", ["--help"]], ["implement-tests", ["--dry-run"]]] as const) {
      expect(await runWithCliMemory(verb, [...args], async () => 0)).toBe(0);
    }
    await expect(stat(cabin)).rejects.toThrow();
  });
  it("loads runtime-file cabin configuration and records only registered files", async () => {
    const path = join(work, "runtime.json");
    await writeFile(path, JSON.stringify({ memoryCabin: { enabled: true, root: cabin, strict: true } }));
    expect(await runWithCliMemory("design-tests", ["--config", path, "--out", out], async () => { await artifacts(); return 0; })).toBe(0);
    expect((await files(cabin)).filter((path) => path.endsWith("report.md"))).toHaveLength(2);
  });
  it.each([
    ["review-pull-request", ["--pr", "123"], "pr-123", "code-review"],
    ["generate-release-notes", ["--issue", "REL-123"], "REL-123", "release-notes"],
    ["analyse-incident", ["--issue", "itsm-123"], "ITSM-123", "incident-analysis"],
  ])("captures only newly generated sibling %s reports", async (verb, args, key, name) => {
    vi.stubEnv("MANSO_MEMORY_ENABLED", "true");
    vi.stubEnv("MANSO_MEMORY_ROOT", cabin);
    vi.stubEnv("MANSO_MEMORY_STRICT", "true");
    const directory = join(out, key);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${name}.md`), "Old report");
    const cliArgs = [...args, "--out", out];
    await runWithCliMemory(verb, cliArgs, async () => 0);
    expect(await files(cabin)).toEqual([]);
    await runWithCliMemory(verb, cliArgs, async () => {
      await writeFile(join(directory, `${name}.json`), '{"result":"New report"}');
      await writeFile(join(directory, `${name}.md`), "New report");
      await writeFile(join(directory, "credentials.json"), '{"secret":"never-uploaded"}');
      return 0;
    });
    const mirrored = await files(cabin);
    expect(mirrored.filter((path) => path.endsWith(`${name}.json`))).toHaveLength(2);
    expect(mirrored.filter((path) => path.endsWith(`${name}.md`))).toHaveLength(2);
    expect(mirrored.some((path) => path.endsWith("credentials.json"))).toBe(false);
  });
});
