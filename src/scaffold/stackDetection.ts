import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/** A test stack detected in a target repository. */
export interface DetectedStack {
  /** Stack identifier, e.g. "playwright-bdd-ts" or "dotnet-reqnroll". */
  id: string;
  /** Stack root directory, relative to the repo root (POSIX-separated). */
  root: string;
  /** Default command that verifies tests for this stack. */
  verifyCommand: string;
  /** Glob for this stack's feature files, when it is a BDD stack. */
  featureGlob: string;
}

interface StackDefaults {
  verifyCommand: string;
  featureGlob: string;
}

/** Per-stack default verify command and feature glob. */
const STACK_DEFAULTS: Record<string, StackDefaults> = {
  "playwright-bdd-ts": { verifyCommand: "npx playwright test", featureGlob: "tests/**/*.feature" },
  "playwright-ui-ts": { verifyCommand: "npx playwright test", featureGlob: "" },
  "cypress-cucumber-ts": { verifyCommand: "npx cypress run", featureGlob: "cypress/e2e/**/*.feature" },
  "cypress-ui-ts": { verifyCommand: "npx cypress run", featureGlob: "" },
  "dotnet-reqnroll": { verifyCommand: "dotnet test", featureGlob: "**/Features/**/*.feature" },
};

/** Directories never worth scanning for stack markers. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".agents",
  ".agent",
  ".idea",
  ".vs",
  "bin",
  "obj",
  "dist",
  "out",
  "build",
  "coverage",
]);

const MAX_DEPTH = 5;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Bounded recursive walk collecting files whose name satisfies `predicate`. */
async function collectFiles(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile() && predicate(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  }

  await walk(root, 0);
  return found;
}

/**
 * Detect the test stacks present in a repository from filesystem markers:
 * `package.json` dependencies and `*.csproj` package references.
 *
 * This is intentionally a heuristic stub — deeper detection (config files,
 * monorepo workspaces) lands in later milestones.
 */
export async function detectStacks(repoRoot: string): Promise<DetectedStack[]> {
  const detected = new Map<string, DetectedStack>();

  const add = (id: string, stackRoot: string): void => {
    if (detected.has(id)) {
      return;
    }
    const defaults = STACK_DEFAULTS[id];
    if (!defaults) {
      return;
    }
    const rel = relative(repoRoot, stackRoot);
    detected.set(id, {
      id,
      root: rel === "" ? "." : toPosix(rel),
      verifyCommand: defaults.verifyCommand,
      featureGlob: defaults.featureGlob,
    });
  };

  const packageJsons = await collectFiles(repoRoot, (name) => name === "package.json");
  for (const packageJsonPath of packageJsons) {
    let deps: Record<string, string> = {};
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      deps = { ...parsed.dependencies, ...parsed.devDependencies };
    } catch {
      continue;
    }

    const dir = dirname(packageJsonPath);
    if ("playwright-bdd" in deps) {
      add("playwright-bdd-ts", dir);
    } else if ("@playwright/test" in deps) {
      add("playwright-ui-ts", dir);
    }
    if ("@badeball/cypress-cucumber-preprocessor" in deps) {
      add("cypress-cucumber-ts", dir);
    } else if ("cypress" in deps) {
      add("cypress-ui-ts", dir);
    }
  }

  const csprojFiles = await collectFiles(repoRoot, (name) => name.endsWith(".csproj"));
  for (const csprojPath of csprojFiles) {
    try {
      if (/Reqnroll/i.test(await readFile(csprojPath, "utf8"))) {
        add("dotnet-reqnroll", dirname(csprojPath));
      }
    } catch {
      // Unreadable project file — skip.
    }
  }

  return [...detected.values()];
}
