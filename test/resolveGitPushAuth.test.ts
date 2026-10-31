import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGitPushAuth } from "../src/integrations/vcs/resolve.js";
import { runShellCommand } from "../src/integrations/shell/runShellCommand.js";

/** Decode the base64 from an "Authorization: Basic <b64>" header. */
function decodeBasic(header: string): string {
  const b64 = header.replace(/^Authorization: Basic /, "");
  return Buffer.from(b64, "base64").toString("utf8");
}

describe("resolveGitPushAuth", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-pushauth-"));
    await runShellCommand("git init -q -b main", { cwd: workDir });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function setOrigin(url: string): Promise<void> {
    await runShellCommand(`git remote add origin "${url}"`, { cwd: workDir });
  }

  it("builds a GitHub Basic header with x-access-token when a token is set", async () => {
    await setOrigin("https://github.com/acme/widgets.git");
    const auth = await resolveGitPushAuth(workDir, { githubToken: "ghp_test123" });
    expect(auth).toBeDefined();
    expect(auth?.description).toBe("github (token)");
    expect(decodeBasic(auth!.extraHeader)).toBe("x-access-token:ghp_test123");
  });

  it("returns undefined for a GitHub remote when no token is provided (local-cred fallback)", async () => {
    await setOrigin("git@github.com:acme/widgets.git");
    const auth = await resolveGitPushAuth(workDir, {});
    expect(auth).toBeUndefined();
  });

  it("builds an Azure DevOps Basic header (empty user) from a PAT", async () => {
    await setOrigin("https://dev.azure.com/acme/proj/_git/repo");
    const auth = await resolveGitPushAuth(workDir, { azureDevOpsToken: "pat_abc" });
    expect(auth?.description).toBe("azure-devops (PAT)");
    expect(decodeBasic(auth!.extraHeader)).toBe(":pat_abc");
  });

  it("prefers GitHub when a GitHub remote is present", async () => {
    await setOrigin("https://github.com/acme/widgets.git");
    const auth = await resolveGitPushAuth(workDir, {
      githubToken: "ghp_test123",
      azureDevOpsToken: "pat_abc",
    });
    expect(auth?.description).toBe("github (token)");
  });

  it("returns undefined for an unrecognized remote", async () => {
    await setOrigin("https://gitlab.com/acme/widgets.git");
    const auth = await resolveGitPushAuth(workDir, {
      githubToken: "ghp_test123",
      azureDevOpsToken: "pat_abc",
    });
    expect(auth).toBeUndefined();
  });
});
