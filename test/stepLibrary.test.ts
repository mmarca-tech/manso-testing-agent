import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractStepLibrary,
  formatStepLibraryForPrompt,
  normalizeStepText,
  resolveDesignRepo,
} from "../src/context/stepLibrary.js";

describe("normalizeStepText", () => {
  it("replaces numbers with <number>", () => {
    expect(normalizeStepText("a customer with an approved checkout of 300.00 EUR")).toBe(
      "a customer with an approved checkout of <number> EUR",
    );
  });

  it("replaces quoted values and outline placeholders with <param>", () => {
    expect(normalizeStepText('the customer selects the "3 instalments" plan')).toBe(
      'the customer selects the "<param>" plan',
    );
    expect(normalizeStepText("the <plan> plan is <visibility>")).toBe("the <param> plan is <param>");
  });
});

describe("extractStepLibrary", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "manso-steplib-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("collects, normalizes, and de-duplicates steps across feature files", async () => {
    await mkdir(join(repo, "tests", "features"), { recursive: true });
    await writeFile(
      join(repo, "tests", "features", "checkout.feature"),
      `@checkout
Feature: Checkout

  Scenario: Eligible plan
    Given a customer with an approved checkout of 300.00 EUR
    When the customer selects the "3 instalments" plan
    Then the order is confirmed

  Scenario: Another amount
    Given a customer with an approved checkout of 50.00 EUR
    When the customer selects the "6 instalments" plan
    Then the order is confirmed
`,
      "utf8",
    );

    const library = await extractStepLibrary({ repoRoot: repo });

    expect(library.featureFileCount).toBe(1);
    expect(library.totalSteps).toBe(6);

    const normalized = library.steps.map((s) => s.normalized);
    // The two "Given ... <number> EUR" steps collapse into one.
    expect(normalized).toContain("a customer with an approved checkout of <number> EUR");
    // The two "selects the <param> plan" steps collapse into one.
    expect(normalized).toContain('the customer selects the "<param>" plan');
    // "the order is confirmed" appears twice → one entry, occurrences 2.
    const confirmed = library.steps.find((s) => s.normalized === "the order is confirmed");
    expect(confirmed?.occurrences).toBe(2);
    // 3 unique steps: the two "<number> EUR" Givens and the two "<param> plan"
    // Whens each collapse to one; "the order is confirmed" appears twice.
    expect(library.steps).toHaveLength(3);
  });

  it("resolves And/But to the previous concrete keyword", async () => {
    await writeFile(
      join(repo, "a.feature"),
      `Feature: F
  Scenario: S
    Given a precondition
    And another precondition
    When an action
    Then an outcome
    And a second outcome
`,
      "utf8",
    );

    const library = await extractStepLibrary({ repoRoot: repo });
    const byText = Object.fromEntries(library.steps.map((s) => [s.normalized, s.keyword]));
    expect(byText["another precondition"]).toBe("Given");
    expect(byText["a second outcome"]).toBe("Then");
  });

  it("returns an empty library for a repo with no feature files", async () => {
    const library = await extractStepLibrary({ repoRoot: repo });
    expect(library.steps).toEqual([]);
    expect(library.featureFileCount).toBe(0);
  });

  it("ignores node_modules and other excluded directories", async () => {
    await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(repo, "node_modules", "pkg", "vendor.feature"),
      "Feature: V\n  Scenario: S\n    Given a vendored step\n",
      "utf8",
    );
    const library = await extractStepLibrary({ repoRoot: repo });
    expect(library.featureFileCount).toBe(0);
  });
});

describe("formatStepLibraryForPrompt", () => {
  it("groups steps by keyword and includes the reuse instruction", async () => {
    const repo = await mkdtemp(join(tmpdir(), "manso-steplib-fmt-"));
    try {
      await writeFile(
        join(repo, "a.feature"),
        "Feature: F\n  Scenario: S\n    Given a logged-in customer\n    When they pay\n    Then the order is confirmed\n",
        "utf8",
      );
      const library = await extractStepLibrary({ repoRoot: repo });
      const text = formatStepLibraryForPrompt(library);
      expect(text).toContain("Existing step vocabulary");
      expect(text).toContain("REUSE these exact step phrasings");
      expect(text).toContain("Given:");
      expect(text).toContain("- a logged-in customer");
      expect(text).toContain("When:");
      expect(text).toContain("Then:");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns an empty string for an empty library", () => {
    expect(
      formatStepLibraryForPrompt({ steps: [], scenarios: [], featureFileCount: 0, totalSteps: 0 }),
    ).toBe("");
  });
});

describe("extractStepLibrary — existing scenarios", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "manso-scenarios-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("collects scenario and scenario-outline titles with their feature", async () => {
    await writeFile(
      join(repo, "login.feature"),
      `Feature: Login

  Scenario: User logs in with valid credentials
    Given a registered user
    When they submit valid credentials
    Then they reach the dashboard

  Scenario Outline: Login is rejected for invalid input
    Given a registered user
    When they submit "<password>"
    Then login is rejected

    Examples:
      | password |
      | wrong    |
`,
      "utf8",
    );

    const library = await extractStepLibrary({ repoRoot: repo });
    expect(library.scenarios).toHaveLength(2);
    const valid = library.scenarios.find((s) => s.title === "User logs in with valid credentials");
    expect(valid?.feature).toBe("Login");
    expect(valid?.outline).toBe(false);
    const outline = library.scenarios.find((s) => s.title === "Login is rejected for invalid input");
    expect(outline?.outline).toBe(true);
  });

  it("de-duplicates identical scenario titles across files", async () => {
    await writeFile(join(repo, "a.feature"), "Feature: A\n  Scenario: Shared title\n    Given x\n", "utf8");
    await writeFile(join(repo, "b.feature"), "Feature: B\n  Scenario: Shared title\n    Given y\n", "utf8");
    const library = await extractStepLibrary({ repoRoot: repo });
    expect(library.scenarios.filter((s) => s.title === "Shared title")).toHaveLength(1);
  });
});

describe("resolveDesignRepo", () => {
  it("prefers an explicit repo path", () => {
    const resolved = resolveDesignRepo({ explicit: "./some/repo" });
    expect(resolved).toEqual({ repoRoot: resolve("./some/repo"), source: "flag" });
  });

  it("resolves a dev-section repository via the repoRoots map", () => {
    const resolved = resolveDesignRepo({
      development: {
        branches: [{ repository: "checkout-web" }],
        pullRequests: [],
      },
      repoRoots: { "checkout-web": "C:/src/checkout-web" },
    });
    expect(resolved?.source).toBe("dev-section");
    expect(resolved?.repository).toBe("checkout-web");
    expect(resolved?.repoRoot).toBe(resolve("C:/src/checkout-web"));
  });

  it("returns undefined when a dev-section repo has no mapping", () => {
    const resolved = resolveDesignRepo({
      development: { branches: [{ repository: "unmapped" }], pullRequests: [] },
      repoRoots: { other: "C:/src/other" },
    });
    expect(resolved).toBeUndefined();
  });

  it("returns undefined with no explicit repo and no dev branches", () => {
    expect(resolveDesignRepo({ development: { branches: [], pullRequests: [] } })).toBeUndefined();
  });
});
