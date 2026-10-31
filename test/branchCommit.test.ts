import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitChangesOnBranch, defaultBranchName } from "../src/integrations/git/branchCommit.js";
import { runShellCommand } from "../src/integrations/shell/runShellCommand.js";

describe("defaultBranchName", () => {
  it("uses the issue key as-is (original casing, no prefix)", () => {
    expect(defaultBranchName("FINT-1056")).toBe("FINT-1056");
    expect(defaultBranchName("ABC-123")).toBe("ABC-123");
  });

  it("replaces unsafe characters with hyphens", () => {
    expect(defaultBranchName("AB$C 1/2")).toBe("AB-C-1-2");
  });
});

describe("commitChangesOnBranch", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-git-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns committed: false with a warning when the dir is not a git work tree", async () => {
    const result = await commitChangesOnBranch({
      repoRoot: workDir,
      branchName: "manso/feature",
      commitMessage: "msg",
    });
    expect(result.committed).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("creates the branch and commits when there are working-tree changes", async () => {
    await initGitRepo(workDir);
    await writeFile(join(workDir, "new-file.txt"), "hello\n", "utf8");

    const result = await commitChangesOnBranch({
      repoRoot: workDir,
      branchName: "manso/test-branch",
      commitMessage: "Manso: implement TEST-1",
      author: "Manso Tester <test@example.com>",
    });

    expect(result.committed).toBe(true);
    expect(result.branch).toBe("manso/test-branch");
    expect(result.pushed).toBe(false);

    const currentBranch = await runShellCommand("git rev-parse --abbrev-ref HEAD", { cwd: workDir });
    expect(currentBranch.stdout.trim()).toBe("manso/test-branch");

    const logOut = await runShellCommand("git log --oneline -1", { cwd: workDir });
    expect(logOut.stdout).toContain("Manso: implement TEST-1");
  });

  it("pushes with token auth and never logs the secret", async () => {
    await initGitRepo(workDir);
    const bareDir = await mkdtemp(join(tmpdir(), "manso-remote-"));
    await runShellCommand("git init -q --bare", { cwd: bareDir });
    await runShellCommand(`git remote add origin "${bareDir}"`, { cwd: workDir });
    await writeFile(join(workDir, "new-file.txt"), "hello\n", "utf8");

    const secret = "Authorization: Basic c3VwZXItc2VjcmV0LXRva2Vu";
    const result = await commitChangesOnBranch({
      repoRoot: workDir,
      branchName: "FINT-1",
      commitMessage: "Manso: implement FINT-1",
      push: true,
      pushAuth: { extraHeader: secret, description: "github (token)" },
    });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    const log = result.log.join("\n");
    // The push command is logged in redacted form; the secret never appears.
    expect(log).toContain("<redacted:github (token)>");
    expect(log).not.toContain(secret);
    expect(log).not.toContain("c3VwZXItc2VjcmV0LXRva2Vu");

    await rm(bareDir, { recursive: true, force: true });
  });

  it("skips the commit step (no error) when there are no changes", async () => {
    await initGitRepo(workDir);

    const result = await commitChangesOnBranch({
      repoRoot: workDir,
      branchName: "manso/empty-branch",
      commitMessage: "noop",
    });

    expect(result.committed).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});

async function initGitRepo(dir: string): Promise<void> {
  const steps = [
    "git init -q -b main",
    'git config user.email "ci@example.com"',
    'git config user.name "Manso CI"',
    "git commit -q --allow-empty -m \"chore: init\"",
  ];
  for (const command of steps) {
    const result = await runShellCommand(command, { cwd: dir });
    if (result.exitCode !== 0) {
      throw new Error(`Setup step failed: ${command}\n${result.stderr}`);
    }
  }
}
