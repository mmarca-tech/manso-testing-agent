import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const pkg = () => JSON.parse(readFileSync("package.json", "utf8"));
const parse = (version) => {
  if (!VERSION.test(version)) throw new Error(`Expected an exact stable semantic version, received: ${version}`);
  const parts = version.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error("Version component exceeds safe integer range.");
  return parts;
};
const compare = (a, b) => {
  const left = parse(a), right = parse(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};
const annotated = (tag) => git("cat-file", "-t", tag) === "tag";
// Lightweight tags are ignored: releases must be immutable annotated tags.
const tags = () => git("tag", "--merged", "HEAD", "--list", "v*").split("\n")
  .filter((tag) => VERSION.test(tag.slice(1)) && annotated(tag)).sort((a, b) => compare(b.slice(1), a.slice(1)));

function plan() {
  const existing = tags();
  const current = existing.find((tag) => git("rev-parse", `${tag}^{commit}`) === git("rev-parse", "HEAD"));
  if (current) return { tag: current, version: current.slice(1), existing: true };
  const latest = existing[0];
  const baseline = pkg().version;
  parse(baseline);
  if (!latest) return { tag: `v${baseline}`, version: baseline, existing: false };
  const messages = git("log", `${latest}..HEAD`, "--format=%B");
  const bump = /(?:semver:\s*major|\[major\]|#major\b)/i.test(messages) ? 0
    : /(?:semver:\s*minor|\[minor\]|#minor\b)/i.test(messages) ? 1 : 2;
  const parts = parse(latest.slice(1));
  parts[bump]++;
  for (let i = bump + 1; i < 3; i++) parts[i] = 0;
  const incremented = parts.join(".");
  parse(incremented);
  const version = compare(baseline, incremented) > 0 ? baseline : incremented;
  return { tag: `v${version}`, version, existing: false };
}

function notes(tag) {
  const previous = tags().find((candidate) => compare(candidate.slice(1), tag.slice(1)) < 0);
  const range = previous ? `${previous}..HEAD` : "HEAD";
  return `# Changelog\n\n## ${tag}\n\n${git("log", range, "--format=- %s (%h)")}\n`;
}

try {
  const command = process.argv[2];
  if (command === "plan") {
    console.log(JSON.stringify(plan(), null, 2));
  } else if (command === "tag") {
    const sourceBranch = process.env.GITHUB_REF ?? process.env.BUILD_SOURCEBRANCH;
    if (sourceBranch && sourceBranch !== "refs/heads/main") {
      throw new Error("Automatic tagging is only allowed on main.");
    }
    if (git("status", "--porcelain")) throw new Error("Release requires a clean worktree.");
    git("fetch", "origin", "--tags");
    const head = git("rev-parse", "HEAD");
    git("fetch", "origin", "main");
    if (head !== git("rev-parse", "FETCH_HEAD")) {
      throw new Error("Refusing to release an outdated main commit. Queue the latest main revision.");
    }
    const sourceVersion = process.env.GITHUB_SHA ?? process.env.BUILD_SOURCEVERSION;
    if (sourceVersion && head !== sourceVersion) {
      throw new Error("Checkout does not match the pipeline source commit.");
    }
    const release = plan();
    if (!release.existing) {
      git("-c", "user.name=Manso Release", "-c", "user.email=manso-agent@example.com",
        "tag", "-a", release.tag, "-m", notes(release.tag), head);
    }
    // Also push an existing local tag: a prior run may have stopped before push.
    git("push", "origin", `refs/tags/${release.tag}`);
    console.log(`ReleaseVersion=${release.version}`);
    console.log(`Release ${release.tag} at ${head}`);
  } else if (command === "align") {
    const ref = process.argv[3];
    const version = (ref ?? "").replace(/^refs\/tags\/v|^v/, "");
    parse(version);
    if (!annotated(`v${version}`)) {
      throw new Error(`Tag v${version} must be an annotated tag.`);
    }
    if (git("rev-parse", `v${version}^{commit}`) !== git("rev-parse", "HEAD")) {
      throw new Error(`Tag v${version} does not identify the checked-out commit.`);
    }
    for (const path of ["package.json", "package-lock.json"]) {
      const json = JSON.parse(readFileSync(path, "utf8"));
      json.version = version;
      if (path === "package-lock.json" && json.packages?.[""]) json.packages[""].version = version;
      writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    }
    const changelog = notes(`v${version}`);
    writeFileSync("CHANGELOG.md", changelog);
    const output = process.argv[4];
    if (output) writeFileSync(output, changelog);
    console.log(`Aligned package to ${version}`);
  } else {
    throw new Error("Usage: node scripts/release.mjs plan | tag | align <vX.Y.Z> [changelog-path]");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
