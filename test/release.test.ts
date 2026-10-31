import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
let repo: string;
let remote: string | undefined;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" });
const plan = () => {
  const result = run("plan");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { version: string; tag: string; existing: boolean };
};
const commit = (message: string) => {
  writeFileSync(join(repo, "change.txt"), message);
  git("add", ".");
  git("commit", "-m", message);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "manso-release-"));
  git("init", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.invalid");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "manso", version: "0.1.0" }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" } } }));
  commit("Initial package");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  if (remote) rmSync(remote, { recursive: true, force: true });
  remote = undefined;
});

describe("release version planning", () => {
  it("bootstraps from package version without requiring a manual first tag", () => {
    expect(plan()).toEqual({ version: "0.1.0", tag: "v0.1.0", existing: false });
    expect(git("tag")).toBe("");
  });
  it("reuses a version already tagging this exact commit", () => {
    git("tag", "-a", "v0.1.0", "-m", "Release");
    expect(plan().existing).toBe(true);
    expect(plan().version).toBe("0.1.0");
  });
  it.each([
    ["Fix a defect", "0.1.1"],
    ["Add feature #minor", "0.2.0"],
    ["Add feature [minor]", "0.2.0"],
    ["Breaking semver:major", "1.0.0"],
    ["Breaking #major", "1.0.0"],
  ])("calculates %s as %s", (message, expected) => {
    git("tag", "-a", "v0.1.0", "-m", "Release");
    commit(message);
    expect(plan().version).toBe(expected);
  });
  it("reads all messages since the previous release, not just the final merge subject", () => {
    git("tag", "-a", "v0.1.0", "-m", "Release");
    commit("Feature [minor]");
    commit("Fix #patch");
    expect(plan().version).toBe("0.2.0");
  });
  it("sorts versions numerically and ignores non-stable tags", () => {
    git("tag", "-a", "v0.9.0", "-m", "Release");
    commit("Next");
    git("tag", "-a", "v0.10.0", "-m", "Release");
    git("tag", "-a", "v99.0.0-preview", "-m", "Preview");
    commit("Fix");
    expect(plan().version).toBe("0.10.1");
  });
  it("ignores a lightweight tag on this commit instead of reusing it as a release", () => {
    git("tag", "v0.1.0");
    expect(plan()).toEqual({ version: "0.1.0", tag: "v0.1.0", existing: false });
  });
  it("honours an explicitly increased package version", () => {
    git("tag", "-a", "v0.1.0", "-m", "Release");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "2.0.0" }));
    commit("Version baseline");
    expect(plan().version).toBe("2.0.0");
  });
  it.each(["01.0.0", "0.1.0-beta", "latest", "1.0", "9007199254740992.0.0"])("rejects invalid baseline %s", (version) => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version }));
    expect(run("plan").status).toBe(1);
  });
});

describe("tag-pinned package alignment", () => {
  it("aligns both manifests and writes release-specific changelog", () => {
    git("tag", "-a", "v1.2.3", "-m", "Release");
    const notes = join(repo, "CHANGELOG.md");
    const result = run("align", "refs/tags/v1.2.3", notes);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version).toBe("1.2.3");
    const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
    expect(lock.version).toBe("1.2.3");
    expect(lock.packages[""].version).toBe("1.2.3");
    expect(readFileSync(notes, "utf8")).toContain("## v1.2.3");
    expect(readFileSync(notes, "utf8")).toContain("Initial package");
  });
  it("rejects a valid version tag pointing to a different commit without changing manifests", () => {
    git("tag", "-a", "v1.0.0", "-m", "Release");
    commit("Later commit");
    expect(run("align", "v1.0.0").status).toBe(1);
    expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version).toBe("0.1.0");
  });
  it("rejects lightweight tags on the checked-out commit without changing manifests", () => {
    git("tag", "v1.0.0");
    const result = run("align", "v1.0.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("annotated");
    expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version).toBe("0.1.0");
  });
  it("rejects missing tags", () => expect(run("align", "v1.0.0").status).toBe(1));
  it("rejects dirty worktrees before attempting any remote write", () => {
    writeFileSync(join(repo, "change.txt"), "uncommitted");
    const result = run("tag");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("clean worktree");
    expect(git("tag")).toBe("");
  });
  it("requires a recognised command", () => expect(run("unknown").status).toBe(1));
});

describe("immutable release tag publication", () => {
  const setupRemote = () => {
    remote = mkdtempSync(join(tmpdir(), "manso-release-remote-"));
    git("init", "--bare", remote);
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
  };
  it("creates an annotated first tag, pushes it and safely reuses it", () => {
    setupRemote();
    const first = run("tag");
    expect(first.status, first.stderr).toBe(0);
    expect(git("cat-file", "-t", "v0.1.0")).toBe("tag");
    expect(git("ls-remote", "--tags", "origin")).toContain("refs/tags/v0.1.0");
    const object = git("rev-parse", "v0.1.0");
    expect(run("tag").status).toBe(0);
    expect(git("rev-parse", "v0.1.0")).toBe(object);
  });

  describe("GitHub Actions release context", () => {
    it("refuses to create a release tag outside main", () => {
      setupRemote();
      const result = spawnSync(process.execPath, [script, "tag"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GITHUB_REF: "refs/heads/feature" },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("only allowed on main");
      expect(git("tag")).toBe("");
    });

    it("refuses to tag a checkout that differs from the workflow commit", () => {
      setupRemote();
      const result = spawnSync(process.execPath, [script, "tag"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GITHUB_REF: "refs/heads/main", GITHUB_SHA: "not-head" },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Checkout does not match the pipeline source commit");
      expect(git("tag")).toBe("");
    });
  });
  it("pushes an existing local tag after an interrupted previous run", () => {
    setupRemote();
    git("tag", "-a", "v0.1.0", "-m", "Release");
    expect(git("ls-remote", "--tags", "origin")).toBe("");
    expect(run("tag").status).toBe(0);
    expect(git("ls-remote", "--tags", "origin")).toContain("refs/tags/v0.1.0");
  });
  it("refuses to tag a checkout newer than remote main", () => {
    setupRemote();
    commit("Unpushed");
    const result = run("tag");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outdated main commit");
    expect(git("tag")).toBe("");
  });
});
