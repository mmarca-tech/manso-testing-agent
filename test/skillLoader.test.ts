import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/main.js";
import { loadSkills } from "../src/skillLoader/loader.js";
import { parseSkill } from "../src/skillLoader/parser.js";
import { CliError } from "../src/shared/cli.js";

const PACKAGED_SKILL_NAMES = [
  "acceptance-criteria-extraction",
  "gherkin-authoring",
  "plain-english-test-authoring",
];

describe("parseSkill", () => {
  it("parses name, description, when, and appliesTo", () => {
    const skill = parseSkill({
      text: `---
name: example
description: An example skill.
when: Use during design.
appliesTo: { phase: design, stacks: [playwright-bdd-ts, dotnet-reqnroll] }
---
Body content here.
`,
      source: "packaged",
      path: "/tmp/example/SKILL.md",
    });

    expect(skill.name).toBe("example");
    expect(skill.description).toBe("An example skill.");
    expect(skill.when).toBe("Use during design.");
    expect(skill.appliesTo?.phase).toBe("design");
    expect(skill.appliesTo?.stacks).toEqual(["playwright-bdd-ts", "dotnet-reqnroll"]);
    expect(skill.body).toBe("Body content here.");
    expect(skill.source).toBe("packaged");
  });

  it("rejects a file with no frontmatter", () => {
    expect(() =>
      parseSkill({ text: "just markdown", source: "packaged", path: "/tmp/x/SKILL.md" }),
    ).toThrow(CliError);
  });

  it("rejects a file with no name in frontmatter", () => {
    expect(() =>
      parseSkill({
        text: `---
description: nope
---
body
`,
        source: "packaged",
        path: "/tmp/x/SKILL.md",
      }),
    ).toThrow(CliError);
  });

  it("rejects an invalid phase value", () => {
    expect(() =>
      parseSkill({
        text: `---
name: x
appliesTo: { phase: bogus }
---
body
`,
        source: "packaged",
        path: "/tmp/x/SKILL.md",
      }),
    ).toThrow(CliError);
  });
});

describe("loadSkills — packaged", () => {
  it("loads the three packaged skills with no filters", async () => {
    const skills = await loadSkills();
    const names = skills.map((skill) => skill.name).sort();
    for (const name of PACKAGED_SKILL_NAMES) {
      expect(names).toContain(name);
    }
    for (const skill of skills) {
      expect(skill.source).toBe("packaged");
    }
  });

  it("ships the M11 MCP skills with the right phases", async () => {
    const skills = await loadSkills();
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    expect(byName.get("playwright-mcp-exploration")?.appliesTo?.phase).toBe("implementation");
    expect(byName.get("selector-strategy")?.appliesTo?.phase).toBe("implementation");
    expect(byName.get("figma-spec-extraction")?.appliesTo?.phase).toBe("design");
  });

  it("filters by phase", async () => {
    const skills = await loadSkills({ phase: "design" });
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.appliesTo?.phase ?? "design").toBe("design");
    }
  });

  it("excludes skills whose declared phase does not match", async () => {
    // Implementation-phase filter excludes all current packaged design skills.
    const skills = await loadSkills({ phase: "implementation" });
    const designSkillNames = PACKAGED_SKILL_NAMES;
    for (const skill of skills) {
      expect(designSkillNames).not.toContain(skill.name);
    }
  });
});

describe("loadSkills — repo overrides", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manso-skills-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("lets a repo override win over a packaged skill", async () => {
    const overrideDir = join(workDir, ".agents", "skills", "gherkin-authoring");
    await mkdir(overrideDir, { recursive: true });
    await writeFile(
      join(overrideDir, "SKILL.md"),
      `---
name: gherkin-authoring
description: Repo override.
appliesTo: { phase: design }
---
Repo-specific guidance.
`,
      "utf8",
    );

    const skills = await loadSkills({ repoRoot: workDir });
    const override = skills.find((skill) => skill.name === "gherkin-authoring");
    expect(override?.source).toBe("repo");
    expect(override?.description).toBe("Repo override.");
  });

  it("adds a repo-only skill that has no packaged counterpart", async () => {
    const newSkillDir = join(workDir, ".agents", "skills", "company-style");
    await mkdir(newSkillDir, { recursive: true });
    await writeFile(
      join(newSkillDir, "SKILL.md"),
      `---
name: company-style
description: Repo-only skill.
appliesTo: { phase: design }
---
Company-specific style rules.
`,
      "utf8",
    );

    const skills = await loadSkills({ repoRoot: workDir });
    expect(skills.find((skill) => skill.name === "company-style")?.source).toBe("repo");
  });
});

describe("runCli skills", () => {
  it("lists the packaged skills", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["skills"]);
    expect(code).toBe(0);
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    for (const name of PACKAGED_SKILL_NAMES) {
      expect(output).toContain(name);
    }
    log.mockRestore();
  });

  it("rejects an invalid --phase", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runCli(["skills", "--phase", "bogus"]);
    expect(code).toBe(1);
    expect(err).toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
});
