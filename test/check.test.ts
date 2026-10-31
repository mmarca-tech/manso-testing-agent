import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRepoReadiness } from "../src/checks/readiness.js";
import { runCli } from "../src/cli/main.js";
import { loadAgentConfig, parseAgentConfig } from "../src/config/agentConfig.js";
import { scaffoldAgentFolder } from "../src/scaffold/scaffold.js";
import { CliError } from "../src/shared/cli.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "manso-check-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Scaffold a repo that has a detectable stack (playwright-bdd). */
async function scaffoldRepoWithStack(): Promise<void> {
  await writeFile(
    join(workDir, "package.json"),
    JSON.stringify({ devDependencies: { "playwright-bdd": "^8.0.0" } }),
    "utf8",
  );
  await scaffoldAgentFolder({ repoRoot: workDir, force: false });
}

describe("loadAgentConfig", () => {
  it("loads and validates a scaffolded config", async () => {
    await scaffoldRepoWithStack();
    const config = await loadAgentConfig(workDir);
    expect(config.schemaVersion).toBe("1.0.0");
    expect(config.testDesign.outputMode).toBe("gherkin");
    expect(config.stacks).toHaveLength(1);
  });

  it("throws a CliError when the config is missing", async () => {
    await expect(loadAgentConfig(workDir)).rejects.toBeInstanceOf(CliError);
  });

  it("throws a CliError when the config is not valid JSON", async () => {
    await scaffoldRepoWithStack();
    await writeFile(join(workDir, ".agents/manso.config.json"), "{ not json", "utf8");
    await expect(loadAgentConfig(workDir)).rejects.toBeInstanceOf(CliError);
  });
});

describe("parseAgentConfig", () => {
  it("rejects an invalid output mode", () => {
    expect(() =>
      parseAgentConfig(
        { schemaVersion: "1.0.0", product: "x", testDesign: { outputMode: "freeform" } },
        "test",
      ),
    ).toThrow(CliError);
  });

  it("applies defaults for omitted optional sections", () => {
    const config = parseAgentConfig({ schemaVersion: "1.0.0", product: "x" }, "test");
    expect(config.testDesign.outputMode).toBe("gherkin");
    expect(config.stacks).toEqual([]);
    expect(config.pr.mention).toBe("@manso");
  });
});

describe("evaluateRepoReadiness", () => {
  it("scores a freshly scaffolded repo at or above 90", async () => {
    await scaffoldRepoWithStack();
    const report = await evaluateRepoReadiness({ repoRoot: workDir });
    expect(report.hardFailure).toBe(false);
    expect(report.score).toBeGreaterThanOrEqual(90);
  });

  it("reports a hard failure for an un-initialized repo", async () => {
    const report = await evaluateRepoReadiness({ repoRoot: workDir });
    expect(report.hardFailure).toBe(true);
    expect(report.score).toBeLessThan(50);
  });

  it("reports a hard failure when a mandatory file is removed", async () => {
    await scaffoldRepoWithStack();
    await rm(join(workDir, ".agents/test-architecture.md"));
    const report = await evaluateRepoReadiness({ repoRoot: workDir });
    expect(report.hardFailure).toBe(true);
  });

  it("counts Jira and Xray credentials when present", async () => {
    await scaffoldRepoWithStack();
    const report = await evaluateRepoReadiness({
      repoRoot: workDir,
      runtimeConfig: {
        jiraRest: {
          jiraUrl: "https://example.atlassian.net",
          jiraUsername: "u",
          jiraApiToken: "t",
          includeConfluence: false,
        },
        xray: {
          baseUrl: "https://xray.cloud.getxray.app",
          clientId: "id",
          clientSecret: "secret",
          testIssueLinkType: "tests",
          testIssueLinkDirection: "test-to-ticket",
        },
      },
    });
    expect(report.score).toBe(100);
  });
});

describe("runCli check", () => {
  it("exits 0 for a scaffolded repo", async () => {
    await scaffoldRepoWithStack();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["check", "--repo", workDir]);
    log.mockRestore();
    expect(code).toBe(0);
  });

  it("exits 1 for an un-initialized repo", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runCli(["check", "--repo", workDir]);
    expect(code).toBe(1);
    expect(error).toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});
