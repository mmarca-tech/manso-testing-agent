import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { TestDesignPackSchema } from "../domain/testDesignPack/schema.js";
import { renderEvalReport, runEval, type EvalCase } from "../eval/harness.js";
import { ReferenceSetSchema } from "../eval/referenceMatch.js";
import { CliError } from "../shared/cli.js";
import type { CommandModule } from "./main.js";

const HELP = `manso eval - score golden test-design packs against the quality gate.

Usage:
  manso eval --cases <dir> [options]

Options:
  --cases <dir>     Directory of golden TestDesignPack *.json files. Required.
                    A pack <name>.json may have a sibling <name>.reference.json
                    holding the HUMAN-written test list for the same ticket
                    ({"source": "...", "cases": [{"title": "..."}]}); the
                    design's semantic RECALL against it is then measured and
                    gated (M23). Extra scenarios beyond the reference are
                    reported but never penalized.
  --gate <n>        Mean-score gate (0-100). Default 80.
  --floor <n>       Per-case floor (0-100). Default 60.
  --min-recall <n>  Reference-recall gate in percent (0-100), applied only to
                    cases that carry a reference. Default 60.
  -h, --help        Show this help.

Scores each pack on AC coverage, traceability, tag hygiene, scenario structure,
title uniqueness, and strategy — plus reference recall when a reference exists.
Exits non-zero when the suite fails the gate, so it can run as a release check
in CI.
`;

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: "string" },
      gate: { type: "string" },
      floor: { type: "string" },
      "min-recall": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values.cases) {
    throw new CliError("--cases <dir> is required (a directory of golden TestDesignPack JSON files).");
  }

  const casesDir = resolve(values.cases);
  const cases = await loadCases(casesDir);
  if (cases.length === 0) {
    throw new CliError(`No TestDesignPack *.json files found in ${casesDir}.`);
  }

  const gateThreshold = values.gate !== undefined ? parseScore(values.gate, "--gate") : 80;
  const caseFloor = values.floor !== undefined ? parseScore(values.floor, "--floor") : 60;
  const minRecall = values["min-recall"] !== undefined ? parseScore(values["min-recall"], "--min-recall") : 60;

  const report = runEval({ cases, gateThreshold, caseFloor, minRecall });
  console.log(renderEvalReport(report));
  return report.passed ? 0 : 1;
}

async function loadCases(dir: string): Promise<EvalCase[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new CliError(`Could not read cases directory ${dir}.`);
  }

  const cases: EvalCase[] = [];
  const packFiles = entries
    .filter((name) => name.toLowerCase().endsWith(".json") && !name.toLowerCase().endsWith(".reference.json"))
    .sort();
  for (const entry of packFiles) {
    const path = join(dir, entry);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new CliError(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = TestDesignPackSchema.safeParse(json);
    if (!parsed.success) {
      throw new CliError(`${path} is not a valid TestDesignPack: ${parsed.error.issues[0]?.message ?? "schema error"}`);
    }
    const name = basename(entry, ".json");
    const reference = await loadReference(join(dir, `${name}.reference.json`));
    cases.push({ name, pack: parsed.data, ...(reference ? { reference } : {}) });
  }
  return cases;
}

/** Load the optional sibling `<name>.reference.json` (human-written test list). */
async function loadReference(path: string) {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined; // no reference for this case — structural scoring only
    }
    throw new CliError(`Could not read reference file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ReferenceSetSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      `${path} is not a valid reference set: ${parsed.error.issues[0]?.message ?? "schema error"} (expected {"cases": [{"title": "..."}]})`,
    );
  }
  return parsed.data;
}

function parseScore(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new CliError(`${flag} must be an integer 0-100; got "${value}".`);
  }
  return n;
}

const command: CommandModule = { run };
export default command;
