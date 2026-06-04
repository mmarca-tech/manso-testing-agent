import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  inferMemoryScopeFromDirectory,
  loadJuanaPersonaFromMemory,
  mirrorArtifactSetToMemory,
  resolveMansoMemoryRoot,
} from "../src/memory/memoryCabin.js";

const originalMemoryRoot = process.env.MANSO_MEMORY_ROOT;
const originalMemoryEnabled = process.env.MANSO_MEMORY_ENABLED;
const originalMemoryStrict = process.env.MANSO_MEMORY_STRICT;
const originalMemoryCacheDir = process.env.MANSO_MEMORY_CACHE_DIR;
const originalMemoryBranch = process.env.MANSO_MEMORY_BRANCH;
const originalAzureDevOpsPat = process.env.AZURE_DEVOPS_PAT;
const originalAzureDevOpsToken = process.env.AZURE_DEVOPS_TOKEN;
const originalSystemAccessToken = process.env.SYSTEM_ACCESSTOKEN;
const originalGitConfigCount = process.env.GIT_CONFIG_COUNT;
const originalGitConfigKey0 = process.env.GIT_CONFIG_KEY_0;
const originalGitConfigValue0 = process.env.GIT_CONFIG_VALUE_0;
const originalFetch = globalThis.fetch;

describe("memory cabin", () => {
  afterEach(() => {
    restoreEnv("MANSO_MEMORY_ROOT", originalMemoryRoot);
    restoreEnv("MANSO_MEMORY_ENABLED", originalMemoryEnabled);
    restoreEnv("MANSO_MEMORY_STRICT", originalMemoryStrict);
    restoreEnv("MANSO_MEMORY_CACHE_DIR", originalMemoryCacheDir);
    restoreEnv("MANSO_MEMORY_BRANCH", originalMemoryBranch);
    restoreEnv("AZURE_DEVOPS_PAT", originalAzureDevOpsPat);
    restoreEnv("AZURE_DEVOPS_TOKEN", originalAzureDevOpsToken);
    restoreEnv("SYSTEM_ACCESSTOKEN", originalSystemAccessToken);
    restoreEnv("GIT_CONFIG_COUNT", originalGitConfigCount);
    restoreEnv("GIT_CONFIG_KEY_0", originalGitConfigKey0);
    restoreEnv("GIT_CONFIG_VALUE_0", originalGitConfigValue0);
    globalThis.fetch = originalFetch;
  });

  it("mirrors JSON and Markdown artifacts into latest and timestamped run folders", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manso-memory-"));
    const memoryRoot = join(tempDir, "manso-memory-cabin");
    const outputDir = join(tempDir, "out", "PROJ-1");
    const jsonPath = join(outputDir, "context.json");
    const markdownPath = join(outputDir, "context.md");

    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(jsonPath, "{ \"ticket\": \"PROJ-1\" }\n", "utf8");
      await writeFile(markdownPath, "# PROJ-1\n", "utf8");
      process.env.MANSO_MEMORY_ROOT = memoryRoot;
      delete process.env.MANSO_MEMORY_ENABLED;

      const result = await mirrorArtifactSetToMemory({
        workflow: "context-pack",
        directory: outputDir,
        files: [
          { path: jsonPath, kind: "json" },
          { path: markdownPath, kind: "markdown" },
        ],
      });

      expect(result).toBeDefined();
      if (!result) {
        throw new Error("Expected memory mirror result.");
      }

      expect(result.latestDirectory).toBe(join(memoryRoot, "artifacts", "jira", "PROJ-1", "latest"));
      expect(await readFile(join(result.latestDirectory, "context.json"), "utf8")).toBe("{ \"ticket\": \"PROJ-1\" }\n");
      expect(await readFile(join(result.latestDirectory, "context.md"), "utf8")).toBe("# PROJ-1\n");
      expect(existsSync(join(result.runDirectory, "context.json"))).toBe(true);
      expect(existsSync(join(result.runDirectory, "context.md"))).toBe(true);

      const manifest = JSON.parse(await readFile(result.latestManifestPath, "utf8")) as {
        workflow: string;
        scope: { type: string; id: string };
        files: Array<{ name: string; kind: string }>;
      };
      expect(manifest.workflow).toBe("context-pack");
      expect(manifest.scope).toEqual({ type: "jira", id: "PROJ-1" });
      expect(manifest.files.map((file) => file.name)).toEqual(["context.json", "context.md"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not mirror artifacts when memory is disabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manso-memory-"));
    const memoryRoot = join(tempDir, "memory");
    const outputDir = join(tempDir, "out", "PROJ-1");
    const jsonPath = join(outputDir, "context.json");

    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(jsonPath, "{}\n", "utf8");
      process.env.MANSO_MEMORY_ROOT = memoryRoot;
      process.env.MANSO_MEMORY_ENABLED = "false";

      const result = await mirrorArtifactSetToMemory({
        workflow: "context-pack",
        directory: outputDir,
        files: [{ path: jsonPath, kind: "json" }],
      });

      expect(result).toBeUndefined();
      expect(existsSync(memoryRoot)).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads Juana's persona from the memory cabin when present", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manso-memory-"));
    const memoryRoot = join(tempDir, "memory");

    try {
      await mkdir(join(memoryRoot, "persona"), { recursive: true });
      await writeFile(join(memoryRoot, "persona", "juana-manso.md"), "Memory persona\n", "utf8");
      process.env.MANSO_MEMORY_ROOT = memoryRoot;

      expect(loadJuanaPersonaFromMemory("Fallback persona")).toBe("Memory persona");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("clones a Git memory remote into the cache directory before writing artifacts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manso-memory-"));
    const sourceRepo = join(tempDir, "source-memory");
    const remoteRepo = join(tempDir, "remote-memory.git");
    const verificationRepo = join(tempDir, "verify-memory");
    const cacheDir = join(tempDir, "cache");
    const outputDir = join(tempDir, "out", "PROJ-1");
    const jsonPath = join(outputDir, "context.json");

    try {
      await mkdir(sourceRepo, { recursive: true });
      runGit(sourceRepo, ["init", "-b", "main"]);
      runGit(sourceRepo, ["config", "user.email", "test@example.invalid"]);
      runGit(sourceRepo, ["config", "user.name", "Test Runner"]);
      await mkdir(join(sourceRepo, "persona"), { recursive: true });
      await writeFile(join(sourceRepo, "persona", "juana-manso.md"), "Remote persona\n", "utf8");
      runGit(sourceRepo, ["add", "."]);
      runGit(sourceRepo, ["commit", "-m", "initial memory"]);
      runGit(tempDir, ["clone", "--bare", sourceRepo, remoteRepo]);

      await mkdir(outputDir, { recursive: true });
      await writeFile(jsonPath, "{}\n", "utf8");
      process.env.MANSO_MEMORY_ROOT = pathToFileURL(remoteRepo).toString();
      process.env.MANSO_MEMORY_CACHE_DIR = cacheDir;

      expect(resolveMansoMemoryRoot()).toContain(cacheDir);
      expect(loadJuanaPersonaFromMemory("Fallback persona")).toBe("Remote persona");

      const result = await mirrorArtifactSetToMemory({
        workflow: "context-pack",
        directory: outputDir,
        files: [{ path: jsonPath, kind: "json" }],
      });

      expect(result).toBeDefined();
      if (!result) {
        throw new Error("Expected memory mirror result.");
      }
      expect(result.root).toContain(cacheDir);
      expect(existsSync(join(result.root, ".git"))).toBe(true);
      expect(await readFile(join(result.latestDirectory, "context.json"), "utf8")).toBe("{}\n");
      runGit(tempDir, ["clone", remoteRepo, verificationRepo]);
      expect(await readFile(join(verificationRepo, "artifacts", "jira", "PROJ-1", "latest", "context.json"), "utf8")).toBe("{}\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pushes memory updates to a pull request branch when the target branch rejects direct pushes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manso-memory-"));
    const sourceRepo = join(tempDir, "source-memory");
    const remoteRepo = join(tempDir, "remote-memory.git");
    const verificationRepo = join(tempDir, "verify-memory");
    const cacheDir = join(tempDir, "cache");
    const outputDir = join(tempDir, "out", "PROJ-1");
    const jsonPath = join(outputDir, "context.json");
    const memoryRemoteUrl = "https://dev.azure.com/acme/Checkout/_git/memory-cabin";
    const pullRequestRequests: Array<{ url: URL; body?: unknown }> = [];

    try {
      await mkdir(sourceRepo, { recursive: true });
      runGit(sourceRepo, ["init", "-b", "main"]);
      runGit(sourceRepo, ["config", "user.email", "test@example.invalid"]);
      runGit(sourceRepo, ["config", "user.name", "Test Runner"]);
      await writeFile(join(sourceRepo, "README.md"), "Memory cabin\n", "utf8");
      runGit(sourceRepo, ["add", "."]);
      runGit(sourceRepo, ["commit", "-m", "initial memory"]);
      runGit(tempDir, ["clone", "--bare", sourceRepo, remoteRepo]);
      const hookPath = join(remoteRepo, "hooks", "pre-receive");
      await writeFile(
        hookPath,
        [
          "#!/bin/sh",
          "while read old new ref; do",
          "  if [ \"$ref\" = \"refs/heads/main\" ]; then",
          "    echo 'main is protected' >&2",
          "    exit 1",
          "  fi",
          "done",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(hookPath, 0o755);

      await mkdir(outputDir, { recursive: true });
      await writeFile(jsonPath, "{}\n", "utf8");
      process.env.MANSO_MEMORY_ROOT = memoryRemoteUrl;
      process.env.MANSO_MEMORY_CACHE_DIR = cacheDir;
      process.env.MANSO_MEMORY_BRANCH = "main";
      process.env.AZURE_DEVOPS_PAT = "token";
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remoteRepo).toString()}.insteadOf`;
      process.env.GIT_CONFIG_VALUE_0 = memoryRemoteUrl;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        pullRequestRequests.push({
          url,
          ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
        });
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ pullRequestId: 77 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      const result = await mirrorArtifactSetToMemory({
        workflow: "context-pack",
        directory: outputDir,
        files: [{ path: jsonPath, kind: "json" }],
      });

      expect(result).toBeDefined();
      runGit(tempDir, ["clone", "--branch", "manso-memory/jira/proj-1", remoteRepo, verificationRepo]);
      expect(await readFile(join(verificationRepo, "artifacts", "jira", "PROJ-1", "latest", "context.json"), "utf8")).toBe("{}\n");
      const createRequest = pullRequestRequests.find((request) =>
        request.body && (request.body as { sourceRefName?: string }).sourceRefName === "refs/heads/manso-memory/jira/proj-1"
      );
      expect(createRequest?.body).toMatchObject({
        sourceRefName: "refs/heads/manso-memory/jira/proj-1",
        targetRefName: "refs/heads/main",
        title: "Update Juana Manso memory for PROJ-1",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20000);

  it("infers Jira, pull request, and miscellaneous artifact scopes", () => {
    expect(inferMemoryScopeFromDirectory(join("out", "PROJ-123"))).toEqual({ type: "jira", id: "PROJ-123" });
    expect(inferMemoryScopeFromDirectory(join("out", "pr-42"))).toEqual({ type: "pull-request", id: "pr-42" });
    expect(inferMemoryScopeFromDirectory(join("out", "ad hoc"))).toEqual({ type: "misc", id: "ad hoc" });
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}
