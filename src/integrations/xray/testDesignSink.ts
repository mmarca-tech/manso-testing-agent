import type {
  GherkinScenario,
  PlainEnglishScenario,
  TestDesignPack,
  XrayApplication,
  XrayAppliedTest,
  XrayRevision,
} from "../../domain/testDesignPack/schema.js";
import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import { matchAgainstReference } from "../../eval/referenceMatch.js";
import { firstPresent, firstString, isRecord, normalizeTestTitle } from "../../shared/utils.js";
import type { AtlassianRestClient } from "../atlassianRest/client.js";
import type { XrayCloudClient } from "./client.js";

export interface ApplyTestDesignInput {
  testDesign: TestDesignPack;
  ticketKey: string;
  /** Jira project key for the new Xray tests (e.g. "ABC"). */
  projectKey: string;
  xray: XrayCloudClient;
  jira: AtlassianRestClient;
  /** Jira issue-link-type name. Defaults to "Tests". */
  linkTypeName?: string;
  /** Link orientation. Defaults to "test-to-ticket". */
  linkDirection?: "test-to-ticket" | "ticket-to-test";
  /**
   * Copy the project's mandatory custom fields from the source story onto each
   * created Test (so project-specific required fields like a Tempo Account are
   * satisfied). Defaults to true. Discovered via Jira createmeta.
   */
  inheritRequiredFields?: boolean;
  /**
   * Explicit Jira field overrides merged onto each created Test (field id →
   * value), e.g. `{ "customfield_15714": { "id": "123" } }`. Wins over inherited
   * values. From the repo's `.agents` config (`xray.testFields`).
   */
  additionalFields?: Record<string, unknown>;
  /** Skip every mutation; only record what would happen. */
  dryRun?: boolean;
  /** Optional progress logger (info-level messages to stderr). */
  onProgress?: (message: string) => void;
}

const CREATE_CUCUMBER_TEST_MUTATION = `
mutation CreateCucumberTest($jira: JSON!, $testType: UpdateTestTypeInput!, $gherkin: String!) {
  createTest(jira: $jira, testType: $testType, gherkin: $gherkin) {
    test {
      issueId
      jira(fields: ["key", "summary"])
    }
    warnings
  }
}
`.trim();

const CREATE_MANUAL_TEST_MUTATION = `
mutation CreateManualTest($jira: JSON!, $testType: UpdateTestTypeInput!, $steps: [CreateStepInput]!) {
  createTest(jira: $jira, testType: $testType, steps: $steps) {
    test {
      issueId
      jira(fields: ["key", "summary"])
    }
    warnings
  }
}
`.trim();

/**
 * Apply a {@link TestDesignPack} to Xray: create one test per scenario — a
 * **Cucumber** test for each Gherkin scenario, a **Manual** test for each
 * plain-English scenario — and link each to the source Jira ticket. Idempotent
 * on re-run via a pre-check of existing linked Test issues (by summary match).
 */
export async function applyTestDesignToXray(input: ApplyTestDesignInput): Promise<XrayApplication> {
  const provenance: ToolProvenance[] = [];
  const warnings: Warning[] = [];
  const tests: XrayAppliedTest[] = [];

  if (input.dryRun) {
    input.onProgress?.("Xray sink: --dry-run mode — no mutations will be performed.");
    return {
      status: "dry-run",
      ticketKey: input.ticketKey,
      tests: input.testDesign.scenarios.map((scenario, index) => ({
        scenarioIndex: index,
        title: scenario.title,
        status: "skipped-existing" as const,
        message: "dry-run: not uploaded",
      })),
      provenance,
      warnings,
    };
  }

  // Resolve the configured link value against Jira's actual link types. The
  // value may be a link-type NAME ("Test") or a relationship DESCRIPTION
  // ("is tested by" / "tests"); we match either and choose the direction so the
  // STORY displays that relationship.
  const { name: linkTypeName, direction: linkDirection } = await resolveLinkType(
    input.jira,
    input.linkTypeName ?? "Tests",
    input.linkDirection ?? "test-to-ticket",
    provenance,
    warnings,
  );
  input.onProgress?.(`Xray sink: linking tests to ${input.ticketKey} via link type "${linkTypeName}" (${linkDirection}).`);

  // Resolve any extra Jira fields the created Test issues need: the project's
  // mandatory fields inherited from the source story, plus explicit overrides.
  // Computed once and merged into every create. May be narrowed mid-run when
  // Jira rejects an attribution-only field (see the reporter retry below).
  let extraFields = await resolveExtraFields(input, provenance, warnings);
  if (Object.keys(extraFields).length > 0) {
    input.onProgress?.(`Xray sink: applying ${Object.keys(extraFields).length} extra Jira field(s) to created tests: ${Object.keys(extraFields).join(", ")}.`);
  }

  let linkedTests: LinkedTestRef[] = [];
  try {
    linkedTests = await listLinkedTests(input, provenance);
  } catch (error) {
    warnings.push({
      section: "xrayApplication",
      toolName: "jira-rest:issuelinks",
      message: `Could not list existing linked tests for ${input.ticketKey}; idempotency check skipped: ${errorMessage(error)}`,
    });
  }
  const existingTitles = new Set(linkedTests.map((t) => normalizeTestTitle(t.title)));

  // M26 — design revision: semantically match the fresh design against the
  // already-linked tests (beyond the exact normalized-title check), so a
  // re-run UPDATES the ticket's test set instead of appending near-duplicates.
  // High threshold: a wrong skip silently loses a needed test, so only skip
  // when very confident it is the same test; borderline pairs still create
  // (status quo) and a human merges.
  const semanticByIndex = new Map<number, { key?: string; title: string; similarity: number }>();
  const semanticallyCoveredExisting = new Set<string>();
  if (linkedTests.length > 0 && input.testDesign.scenarios.length > 0) {
    const designTitles = input.testDesign.scenarios.map((s) => s.title);
    const match = matchAgainstReference(designTitles, {
      cases: linkedTests.map((t) => ({ title: t.title })),
      threshold: REVISION_MATCH_THRESHOLD,
    });
    const usedIndexes = new Set<number>();
    for (const pair of match.matched) {
      const index = designTitles.findIndex((t, i) => t === pair.scenarioTitle && !usedIndexes.has(i));
      if (index < 0) continue;
      usedIndexes.add(index);
      const existing = linkedTests.find((t) => t.title === pair.referenceTitle);
      semanticByIndex.set(index, {
        ...(existing?.key ? { key: existing.key } : {}),
        title: pair.referenceTitle,
        similarity: pair.similarity,
      });
      semanticallyCoveredExisting.add(normalizeTestTitle(pair.referenceTitle));
    }
  }

  // Titles created in THIS run (normalized), so two near-identically titled
  // scenarios in one design don't both become Xray tests.
  const createdTitles = new Set<string>();

  for (let index = 0; index < input.testDesign.scenarios.length; index += 1) {
    const scenario = input.testDesign.scenarios[index];
    if (!scenario) continue;

    const normalizedTitle = normalizeTestTitle(scenario.title);
    if (existingTitles.has(normalizedTitle)) {
      input.onProgress?.(`Skipping "${scenario.title}" — already linked to ${input.ticketKey}.`);
      tests.push({
        scenarioIndex: index,
        title: scenario.title,
        status: "skipped-existing",
        message: "An Xray test with this title is already linked to the ticket.",
      });
      continue;
    }
    if (createdTitles.has(normalizedTitle)) {
      input.onProgress?.(`Skipping "${scenario.title}" — duplicate of another scenario in this design.`);
      tests.push({
        scenarioIndex: index,
        title: scenario.title,
        status: "skipped-existing",
        message: "Duplicate of another scenario in this design (same title after normalization).",
      });
      continue;
    }
    const semantic = semanticByIndex.get(index);
    if (semantic) {
      input.onProgress?.(`Skipping "${scenario.title}" — semantically matches linked test ${semantic.key ?? ""} "${semantic.title}".`);
      tests.push({
        scenarioIndex: index,
        title: scenario.title,
        status: "skipped-existing",
        ...(semantic.key ? { key: semantic.key } : {}),
        message: `Semantically matches linked test ${semantic.key ? `${semantic.key} ` : ""}"${semantic.title}" (similarity ${semantic.similarity}).`,
      });
      continue;
    }

    // Gherkin → Cucumber test; plain-English → Manual test.
    const testKind = scenario.kind === "gherkin" ? "Cucumber" : "Manual";
    input.onProgress?.(`Creating ${testKind} test ${index + 1}/${input.testDesign.scenarios.length}: ${scenario.title}`);
    try {
      let created: CreatedTest;
      try {
        created =
          scenario.kind === "gherkin"
            ? await createCucumberTest(input, scenario, provenance, extraFields)
            : await createManualTest(input, scenario, provenance, extraFields);
      } catch (error) {
        // Attribution must never sink the upload: when Jira rejects the
        // `reporter` field (the integration account lacks "Modify Reporter"
        // in this project, or the field isn't on the create screen), drop it
        // for the REST OF THE RUN and retry this scenario once. Observed live:
        // MPORTAL run where all 14 creates failed on exactly this.
        if (!("reporter" in extraFields) || !isReporterRejection(errorMessage(error))) {
          throw error;
        }
        warnings.push({
          section: "xrayApplication",
          toolName: "xray:createTest",
          message: `Jira rejected the "reporter" field in ${input.projectKey} (the integration account likely lacks "Modify Reporter" permission) — creating tests WITHOUT reporter attribution for this run.`,
        });
        input.onProgress?.(`Reporter field rejected by ${input.projectKey} — retrying without reporter attribution.`);
        const narrowed = { ...extraFields };
        delete narrowed.reporter;
        extraFields = narrowed;
        created =
          scenario.kind === "gherkin"
            ? await createCucumberTest(input, scenario, provenance, extraFields)
            : await createManualTest(input, scenario, provenance, extraFields);
      }
      if (created.key) {
        try {
          await linkTestToTicket({
            jira: input.jira,
            ticketKey: input.ticketKey,
            testKey: created.key,
            linkTypeName,
            linkDirection,
          }, provenance);
        } catch (error) {
          warnings.push({
            section: "xrayApplication",
            toolName: "jira-rest:issueLink",
            message: `Created ${created.key} but failed to link to ${input.ticketKey}: ${errorMessage(error)}`,
          });
        }
      } else {
        warnings.push({
          section: "xrayApplication",
          toolName: "xray:createTest",
          message: `Created an Xray test for "${scenario.title}" but the response did not include an issue key; cannot link to ${input.ticketKey}.`,
        });
      }

      createdTitles.add(normalizedTitle);
      tests.push({
        scenarioIndex: index,
        title: scenario.title,
        status: "created",
        ...(created.key ? { key: created.key } : {}),
        ...(created.issueId ? { issueId: created.issueId } : {}),
      });
    } catch (error) {
      const message = errorMessage(error);
      warnings.push({
        section: "xrayApplication",
        toolName: "xray:createTest",
        message: `Failed to create ${testKind} test for "${scenario.title}": ${message}`,
      });
      tests.push({
        scenarioIndex: index,
        title: scenario.title,
        status: "failed",
        message,
      });
    }
  }

  // M26 — retire candidates: manso-created linked tests that NOTHING in
  // the latest design covers (neither exact-normalized nor semantic). Reported
  // for human review; never deleted automatically.
  let revision: XrayRevision | undefined;
  if (linkedTests.length > 0) {
    const designNormalized = new Set(input.testDesign.scenarios.map((s) => normalizeTestTitle(s.title)));
    const mansoKeys = await fetchMansoKeys(input, linkedTests.map((t) => t.key), provenance, warnings);
    const seenKeys = new Set<string>();
    const retireCandidates = linkedTests.filter((t) => {
      if (!mansoKeys.has(t.key) || seenKeys.has(t.key)) return false;
      seenKeys.add(t.key);
      const norm = normalizeTestTitle(t.title);
      return !designNormalized.has(norm) && !semanticallyCoveredExisting.has(norm);
    });
    const kept: XrayRevision["kept"] = [...semanticByIndex.entries()].map(([index, m]) => ({
      scenarioTitle: input.testDesign.scenarios[index]?.title ?? "",
      ...(m.key ? { matchedKey: m.key } : {}),
      matchedTitle: m.title,
      similarity: m.similarity,
    }));
    revision = { kept, retireCandidates: retireCandidates.map((t) => ({ key: t.key, title: t.title })) };
    if (revision.retireCandidates.length > 0) {
      await postRevisionComment(input, revision, tests, provenance, warnings);
    }
  }

  return {
    status: "applied",
    ...(revision ? { revision } : {}),
    ticketKey: input.ticketKey,
    tests,
    provenance,
    warnings,
  };
}

/** Render a single Gherkin scenario as the body sent to Xray's `gherkin` field. */
export function renderScenarioGherkin(scenario: GherkinScenario): string {
  const lines: string[] = [];
  if (scenario.tags.length > 0) {
    lines.push(scenario.tags.join(" "));
  }
  const opening = scenario.examples ? "Scenario Outline" : "Scenario";
  lines.push(`${opening}: ${scenario.title}`);
  for (const step of scenario.steps) {
    lines.push(`  ${step.keyword} ${step.text}`);
    for (const row of step.dataTable ?? []) {
      lines.push(`    | ${row.join(" | ")} |`);
    }
  }
  if (scenario.examples) {
    lines.push("Examples:");
    lines.push(`  | ${scenario.examples.headers.join(" | ")} |`);
    for (const row of scenario.examples.rows) {
      lines.push(`  | ${row.join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

interface CreatedTest {
  key?: string;
  issueId?: string;
}

async function createCucumberTest(
  input: ApplyTestDesignInput,
  scenario: GherkinScenario,
  provenance: ToolProvenance[],
  extraFields: Record<string, unknown> = {},
): Promise<CreatedTest> {
  const calledAt = new Date().toISOString();
  try {
    const response = await input.xray.graphql(CREATE_CUCUMBER_TEST_MUTATION, {
      testType: { name: "Cucumber" },
      gherkin: renderScenarioGherkin(scenario),
      jira: {
        fields: {
          // Project-mandatory fields first, so our base fields below always win.
          ...extraFields,
          project: { key: input.projectKey },
          summary: scenario.title,
          labels: ["manso", `story-${input.ticketKey}`],
          description: scenario.objective,
        },
      },
    });

    provenance.push({
      method: "createCucumberTest",
      toolName: "xray:createTest",
      calledAt,
      success: true,
    });

    const test = firstPresent(response, ["data.createTest.test"]);
    const key = extractIssueKey(test);
    const issueId = firstString(test, ["issueId"]);
    return {
      ...(key ? { key } : {}),
      ...(issueId ? { issueId } : {}),
    };
  } catch (error) {
    provenance.push({
      method: "createCucumberTest",
      toolName: "xray:createTest",
      calledAt,
      success: false,
      message: errorMessage(error),
    });
    throw error;
  }
}

/**
 * Create an Xray **Manual** test from a plain-English scenario: each step's
 * `action` + `expectedResult` becomes a manual step (`action` + `result`).
 */
async function createManualTest(
  input: ApplyTestDesignInput,
  scenario: PlainEnglishScenario,
  provenance: ToolProvenance[],
  extraFields: Record<string, unknown> = {},
): Promise<CreatedTest> {
  const calledAt = new Date().toISOString();
  try {
    const response = await input.xray.graphql(CREATE_MANUAL_TEST_MUTATION, {
      testType: { name: "Manual" },
      steps: scenario.steps.map((step) => ({ action: step.action, result: step.expectedResult })),
      jira: {
        fields: {
          // Project-mandatory fields first, so our base fields below always win.
          ...extraFields,
          project: { key: input.projectKey },
          summary: scenario.title,
          labels: ["manso", `story-${input.ticketKey}`],
          description: scenario.objective,
        },
      },
    });

    provenance.push({
      method: "createManualTest",
      toolName: "xray:createTest",
      calledAt,
      success: true,
    });

    const test = firstPresent(response, ["data.createTest.test"]);
    const key = extractIssueKey(test);
    const issueId = firstString(test, ["issueId"]);
    return {
      ...(key ? { key } : {}),
      ...(issueId ? { issueId } : {}),
    };
  } catch (error) {
    provenance.push({
      method: "createManualTest",
      toolName: "xray:createTest",
      calledAt,
      success: false,
      message: errorMessage(error),
    });
    throw error;
  }
}

interface LinkTestInput {
  jira: AtlassianRestClient;
  ticketKey: string;
  testKey: string;
  linkTypeName: string;
  linkDirection: "test-to-ticket" | "ticket-to-test";
}

/**
 * Resolve a configured link value into a concrete Jira link-type name + the
 * direction that makes the STORY display that relationship.
 *
 * The value may be the link-type **name** (e.g. "Test") or a relationship
 * **description** (e.g. "is tested by" / "tests"). We fetch Jira's link types
 * and match by name first, then by inward/outward description.
 *
 * Jira's linked-issues panel labels each link by the side the *other* issue
 * sits on: on the STORY, a test placed as the `inwardIssue` shows under the
 * type's **inward** phrase; placed as the `outwardIssue` it shows under the
 * **outward** phrase. So to make the STORY display the configured phrase:
 *   - matched on `inward`  ("is tested by") → the TEST must be the inwardIssue,
 *     i.e. `ticket-to-test` orientation.
 *   - matched on `outward` ("tests")        → the TEST must be the outwardIssue,
 *     i.e. `test-to-ticket` orientation.
 *   - matched on `name`                     → keep the configured direction.
 * Falls back to using the value as a literal name when nothing matches.
 */
async function resolveLinkType(
  jira: AtlassianRestClient,
  configured: string,
  fallbackDirection: "test-to-ticket" | "ticket-to-test",
  provenance: ToolProvenance[],
  warnings: Warning[],
): Promise<{ name: string; direction: "test-to-ticket" | "ticket-to-test" }> {
  const want = configured.trim().toLowerCase();
  const calledAt = new Date().toISOString();
  try {
    const response = await jira.getJson("jira", "/rest/api/3/issueLinkType");
    provenance.push({ method: "getIssueLinkTypes", toolName: "jira-rest:issueLinkType", calledAt, success: true });
    const types = isRecord(response) && Array.isArray(response.issueLinkTypes) ? response.issueLinkTypes : [];

    let nameMatch: string | undefined;
    for (const type of types) {
      if (!isRecord(type)) continue;
      const name = firstString(type, ["name"]);
      const inward = firstString(type, ["inward"]);
      const outward = firstString(type, ["outward"]);
      if (!name) continue;
      if (inward && inward.trim().toLowerCase() === want) {
        // Story should display the inward phrase ("is tested by") → the test is
        // the inwardIssue → ticket-to-test orientation.
        return { name, direction: "ticket-to-test" };
      }
      if (outward && outward.trim().toLowerCase() === want) {
        // Story should display the outward phrase ("tests") → the test is the
        // outwardIssue → test-to-ticket orientation.
        return { name, direction: "test-to-ticket" };
      }
      if (name.trim().toLowerCase() === want) {
        nameMatch = name;
      }
    }
    if (nameMatch) {
      return { name: nameMatch, direction: fallbackDirection };
    }
    warnings.push({
      section: "xrayApplication",
      toolName: "jira-rest:issueLinkType",
      message: `Link type "${configured}" did not match any Jira link type name or relationship; using it literally with ${fallbackDirection}. Available: ${types
        .map((t) => (isRecord(t) ? firstString(t, ["name"]) : undefined))
        .filter(Boolean)
        .join(", ")}`,
    });
  } catch (error) {
    provenance.push({ method: "getIssueLinkTypes", toolName: "jira-rest:issueLinkType", calledAt, success: false, message: errorMessage(error) });
    warnings.push({
      section: "xrayApplication",
      toolName: "jira-rest:issueLinkType",
      message: `Could not fetch Jira link types (${errorMessage(error)}); using "${configured}" literally with ${fallbackDirection}.`,
    });
  }
  return { name: configured, direction: fallbackDirection };
}

/** Base/system fields we set ourselves or never want to copy from the story. */
const INHERIT_DENYLIST = new Set(["summary", "description", "issuetype", "project", "reporter", "assignee", "labels"]);

/**
 * Resolve the extra Jira fields each created Test should carry:
 *   1. inherit the project's mandatory fields from the source story (so
 *      project-specific required fields like a Tempo Account are satisfied), then
 *   2. apply explicit `additionalFields` overrides (which win).
 * Best-effort: any discovery/read failure is warned and skipped, leaving the
 * overrides (and the base create) intact.
 */
async function resolveExtraFields(
  input: ApplyTestDesignInput,
  provenance: ToolProvenance[],
  warnings: Warning[],
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  if (input.inheritRequiredFields !== false) {
    try {
      const requiredIds = (await discoverRequiredFieldIds(input.jira, input.projectKey, provenance)).filter(
        (id) => !INHERIT_DENYLIST.has(id),
      );
      if (requiredIds.length > 0) {
        const storyValues = await readStoryFields(input.jira, input.ticketKey, requiredIds, provenance);
        for (const id of requiredIds) {
          const value = storyValues[id];
          if (value === undefined || value === null) {
            warnings.push({
              section: "xrayApplication",
              toolName: "jira-rest:createmeta",
              message: `Field "${id}" is required for Test issues in ${input.projectKey} but is not set on ${input.ticketKey}; set xray.testFields["${id}"] in .agents config if creation fails.`,
            });
          } else if (typeof value === "object") {
            // A field's READ shape (e.g. {id, value} for selects/Tempo, {accountId}
            // for users) rarely matches its WRITE shape, so blindly sending it
            // causes cryptic create errors. Skip it and tell the user to set the
            // exact write value via the override.
            const hint = isRecord(value) && (typeof value.id === "number" || typeof value.id === "string")
              ? ` (its id is ${JSON.stringify(value.id)})`
              : "";
            warnings.push({
              section: "xrayApplication",
              toolName: "jira-rest:createmeta",
              message: `Field "${id}" is required for Test issues in ${input.projectKey} and has a structured value on ${input.ticketKey} that may not round-trip on create${hint}; set xray.testFields["${id}"] in .agents config to the value Jira expects.`,
            });
          } else {
            out[id] = value; // primitives (string/number/boolean) round-trip safely
          }
        }
      }
    } catch (error) {
      warnings.push({
        section: "xrayApplication",
        toolName: "jira-rest:createmeta",
        message: `Could not inherit required fields from ${input.ticketKey}: ${errorMessage(error)}. If creation fails on a required field, set xray.testFields in .agents config.`,
      });
    }
  }

  for (const [id, value] of Object.entries(input.additionalFields ?? {})) {
    out[id] = value; // explicit overrides win
  }
  return out;
}

/** Required field ids for the project's "Test" issue type, via Jira createmeta. */
async function discoverRequiredFieldIds(
  jira: AtlassianRestClient,
  projectKey: string,
  provenance: ToolProvenance[],
): Promise<string[]> {
  const calledAt = new Date().toISOString();
  const response = await jira.getJson("jira", "/rest/api/3/issue/createmeta", {
    projectKeys: projectKey,
    expand: "projects.issuetypes.fields",
  });
  provenance.push({ method: "getCreateMeta", toolName: "jira-rest:createmeta", calledAt, success: true });

  const projects = firstPresent(response, ["projects"]);
  const project = Array.isArray(projects) ? projects.find(isRecord) : undefined;
  const issueTypes = project ? firstPresent(project, ["issuetypes"]) : undefined;
  const types = Array.isArray(issueTypes) ? issueTypes.filter(isRecord) : [];
  const name = (t: Record<string, unknown>): string => (firstString(t, ["name"]) ?? "").toLowerCase();
  const testType =
    types.find((t) => name(t) === "test") ??
    types.find((t) => /test/i.test(name(t)) && !/plan|set|execution|precondition/i.test(name(t)));
  if (!testType || !isRecord(testType.fields)) {
    return [];
  }
  const ids: string[] = [];
  for (const [fieldId, meta] of Object.entries(testType.fields)) {
    if (isRecord(meta) && meta.required === true) {
      ids.push(fieldId);
    }
  }
  return ids;
}

/** Read the given field ids from the story issue. */
async function readStoryFields(
  jira: AtlassianRestClient,
  ticketKey: string,
  fieldIds: string[],
  provenance: ToolProvenance[],
): Promise<Record<string, unknown>> {
  const calledAt = new Date().toISOString();
  const response = await jira.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(ticketKey)}`, {
    fields: fieldIds.join(","),
  });
  provenance.push({ method: "getIssueFields", toolName: "jira-rest:issue", calledAt, success: true });
  const fields = firstPresent(response, ["fields"]);
  return isRecord(fields) ? (fields as Record<string, unknown>) : {};
}

async function linkTestToTicket(input: LinkTestInput, provenance: ToolProvenance[]): Promise<void> {
  const body =
    input.linkDirection === "test-to-ticket"
      ? {
          type: { name: input.linkTypeName },
          inwardIssue: { key: input.ticketKey },
          outwardIssue: { key: input.testKey },
        }
      : {
          type: { name: input.linkTypeName },
          inwardIssue: { key: input.testKey },
          outwardIssue: { key: input.ticketKey },
        };

  const calledAt = new Date().toISOString();
  try {
    await input.jira.postJson("jira", "/rest/api/3/issueLink", body);
    provenance.push({
      method: "linkTestToTicket",
      toolName: "jira-rest:issueLink",
      calledAt,
      success: true,
    });
  } catch (error) {
    provenance.push({
      method: "linkTestToTicket",
      toolName: "jira-rest:issueLink",
      calledAt,
      success: false,
      message: errorMessage(error),
    });
    throw error;
  }
}

/** A Test issue linked to the story. */
interface LinkedTestRef {
  key: string;
  title: string;
}

/** Confidence floor for treating a design scenario as "already covered" by an
 *  existing linked test (M26). Deliberately high: a wrong skip silently loses a
 *  needed test, while a wrong create is a visible duplicate a human can merge. */
const REVISION_MATCH_THRESHOLD = 0.75;

/** Linked Test issues on the story (key + summary). */
async function listLinkedTests(
  input: ApplyTestDesignInput,
  provenance: ToolProvenance[],
): Promise<LinkedTestRef[]> {
  const calledAt = new Date().toISOString();
  const response = await input.jira.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(input.ticketKey)}`, {
    fields: "issuelinks",
  });
  provenance.push({
    method: "listLinkedTests",
    toolName: "jira-rest:issuelinks",
    calledAt,
    success: true,
  });

  const found: LinkedTestRef[] = [];
  const links = firstPresent(response, ["fields.issuelinks", "issuelinks"]);
  if (!Array.isArray(links)) {
    return found;
  }

  for (const link of links) {
    if (!isRecord(link)) continue;
    for (const side of ["inwardIssue", "outwardIssue"] as const) {
      const issue = link[side];
      if (!isRecord(issue)) continue;
      // Match "Test" and "Test Case" (instance-dependent naming).
      const issueType = (firstString(issue, ["fields.issuetype.name", "issuetype.name"]) ?? "").toLowerCase();
      if (!issueType.includes("test")) continue;
      const summary = firstString(issue, ["fields.summary", "summary"]);
      const key = firstString(issue, ["key"]);
      if (summary && key) found.push({ key, title: summary });
    }
  }
  return found;
}

/**
 * Which of these linked tests did Manso create? Only those are retire
 * candidates — a hand-written test the team added must never be proposed for
 * retirement just because the agent's latest design doesn't cover it.
 * Identified by the "manso" label the sink stamps on every created test.
 */
async function fetchMansoKeys(
  input: ApplyTestDesignInput,
  keys: string[],
  provenance: ToolProvenance[],
  warnings: Warning[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (keys.length === 0) return out;
  const calledAt = new Date().toISOString();
  try {
    const jql = `key in (${[...new Set(keys)].join(",")}) AND labels = "manso"`;
    const response = await input.jira.getJson("jira", "/rest/api/3/search/jql", {
      jql,
      fields: "key",
      maxResults: "200",
    });
    const issues = firstPresent(response, ["issues"]);
    for (const issue of Array.isArray(issues) ? issues : []) {
      const key = firstString(issue, ["key"]);
      if (key) out.add(key);
    }
    provenance.push({ method: "fetchMansoKeys", toolName: "jira-rest:search", calledAt, success: true });
  } catch (error) {
    // Without this we cannot tell agent-created tests from hand-written ones —
    // so report NO retire candidates rather than risk proposing a human's test.
    provenance.push({ method: "fetchMansoKeys", toolName: "jira-rest:search", calledAt, success: false, message: errorMessage(error) });
    warnings.push({
      section: "xrayApplication",
      toolName: "jira-rest:search",
      message: `Could not identify manso-created linked tests; retirement candidates not reported: ${errorMessage(error)}`,
    });
  }
  return out;
}

/**
 * Post the revision delta as a Jira comment (M26): what was added, what was
 * kept because an existing test already covers it, and which agent-created
 * tests now look obsolete — for a human to confirm. Best-effort.
 */
async function postRevisionComment(
  input: ApplyTestDesignInput,
  revision: XrayRevision,
  tests: XrayAppliedTest[],
  provenance: ToolProvenance[],
  warnings: Warning[],
): Promise<void> {
  const created = tests.filter((t) => t.status === "created");
  const text = (value: string, marks?: string[]) => ({
    type: "text",
    text: value,
    ...(marks ? { marks: marks.map((m) => ({ type: m })) } : {}),
  });
  const paragraph = (...inline: unknown[]) => ({ type: "paragraph", content: inline });
  const heading = (level: number, value: string) => ({ type: "heading", attrs: { level }, content: [text(value)] });
  const bulletList = (items: string[]) => ({
    type: "bulletList",
    content: items.map((item) => ({ type: "listItem", content: [paragraph(text(item))] })),
  });

  const content: unknown[] = [heading(3, "Manso design revision")];
  content.push(
    paragraph(
      text(`This re-run added ${created.length} test(s), kept ${revision.kept.length} already covered, and found `),
      text(`${revision.retireCandidates.length} test(s) the latest design no longer covers`, ["strong"]),
      text("."),
    ),
  );
  if (created.length > 0) {
    content.push(heading(4, "Added"));
    content.push(bulletList(created.map((t) => `${t.key ? `${t.key}: ` : ""}${t.title}`)));
  }
  if (revision.retireCandidates.length > 0) {
    content.push(heading(4, "Possibly obsolete — please review"));
    content.push(bulletList(revision.retireCandidates.map((t) => `${t.key}: ${t.title}`)));
    content.push(
      paragraph(text("These were created by Manso earlier and are NOT covered by the latest design. Nothing was deleted — retire them manually if they are no longer relevant.", ["em"])),
    );
  }

  const calledAt = new Date().toISOString();
  try {
    await input.jira.postJson("jira", `/rest/api/3/issue/${encodeURIComponent(input.ticketKey)}/comment`, {
      body: { type: "doc", version: 1, content },
    });
    provenance.push({ method: "postRevisionComment", toolName: "jira:comment", calledAt, success: true });
    input.onProgress?.(`Posted design-revision comment on ${input.ticketKey} (${revision.retireCandidates.length} possibly-obsolete test(s)).`);
  } catch (error) {
    provenance.push({ method: "postRevisionComment", toolName: "jira:comment", calledAt, success: false, message: errorMessage(error) });
    warnings.push({
      section: "xrayApplication",
      toolName: "jira:comment",
      message: `Could not post the design-revision comment: ${errorMessage(error)}`,
    });
  }
}

function extractIssueKey(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = firstString(payload, ["key", "issueKey"]);
  if (direct) return direct;
  const jira = payload.jira;
  if (isRecord(jira)) return firstString(jira, ["key"]);
  return undefined;
}

/**
 * Does this create-failure mean "the reporter field is not settable here"?
 * Jira's phrasing: `reporter: Field 'reporter' cannot be set. It is not on
 * the appropriate screen, or unknown.` Exported for tests.
 */
export function isReporterRejection(message: string): boolean {
  return /reporter[^]*?cannot be set/i.test(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
