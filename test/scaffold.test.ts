import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/main.js";
import { scaffoldAgentFolder } from "../src/scaffold/scaffold.js";
import { detectStacks } from "../src/scaffold/stackDetection.js";
import { CliError } from "../src/shared/cli.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "manso-scaffold-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("scaffoldAgentFolder", () => {
  it("creates the .agents folder, mandatory files, and AGENTS.md", async () => {
    const result = await scaffoldAgentFolder({ repoRoot: workDir, force: false });

    expect(result.created).toContain("AGENTS.md");
    expect(result.created).toContain(".agents/manso.config.json");
    expect(result.created).toContain(".agents/test-architecture.md");
    expect(result.created).toContain(".agents/test-conventions.json");

    const config = JSON.parse(
      await readFile(join(workDir, ".agents/manso.config.json"), "utf8"),
    ) as { schemaVersion: string; testDesign: { outputMode: string } };
    expect(config.schemaVersion).toBe("1.0.0");
    expect(config.testDesign.outputMode).toBe("gherkin");
  });

  it("refuses to overwrite existing files without --force", async () => {
    await scaffoldAgentFolder({ repoRoot: workDir, force: false });
    await expect(
      scaffoldAgentFolder({ repoRoot: workDir, force: false }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("overwrites existing files with --force", async () => {
    await scaffoldAgentFolder({ repoRoot: workDir, force: false });
    const result = await scaffoldAgentFolder({ repoRoot: workDir, force: true });
    expect(result.created.length).toBeGreaterThan(0);
  });

  it("rejects a non-existent repository path", async () => {
    await expect(
      scaffoldAgentFolder({ repoRoot: join(workDir, "missing"), force: false }),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe("detectStacks", () => {
  it("detects playwright-bdd from package.json dependencies", async () => {
    await writeFile(
      join(workDir, "package.json"),
      JSON.stringify({
        devDependencies: { "playwright-bdd": "^8.0.0", "@playwright/test": "^1.49.0" },
      }),
      "utf8",
    );
    const stacks = await detectStacks(workDir);
    expect(stacks.map((stack) => stack.id)).toContain("playwright-bdd-ts");
  });

  it("detects dotnet-reqnroll from a csproj package reference", async () => {
    await writeFile(
      join(workDir, "Tests.csproj"),
      '<Project><ItemGroup><PackageReference Include="Reqnroll" Version="2.0.0" /></ItemGroup></Project>',
      "utf8",
    );
    const stacks = await detectStacks(workDir);
    expect(stacks.map((stack) => stack.id)).toContain("dotnet-reqnroll");
  });

  it("returns an empty list when nothing is detected", async () => {
    expect(await detectStacks(workDir)).toEqual([]);
  });
});

describe("runCli init", () => {
  it("scaffolds via the CLI and exits 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["init", "--repo", workDir]);
    log.mockRestore();

    expect(code).toBe(0);
    await expect(stat(join(workDir, ".agents/manso.config.json"))).resolves.toBeDefined();
  });

  it("exits 1 cleanly when re-run without --force", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCli(["init", "--repo", workDir]);
    const code = await runCli(["init", "--repo", workDir]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});
