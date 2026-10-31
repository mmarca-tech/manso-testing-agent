import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendRunCost, costLedgerPath, ledgerDay, readDayCost } from "../src/policy/costLedger.js";
import { checkBudget } from "../src/policy/budget.js";

describe("cost ledger", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "manso-ledger-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sums only the entries for the requested day", async () => {
    const path = join(dir, "cost-ledger.jsonl");
    const t1 = () => new Date("2026-01-01T09:00:00.000Z");
    const t2 = () => new Date("2026-01-01T15:00:00.000Z");
    const other = () => new Date("2026-01-02T09:00:00.000Z");

    await appendRunCost(path, { runCostUsd: 1.25, issueKey: "FINT-1", now: t1 });
    await appendRunCost(path, { runCostUsd: 0.75, issueKey: "FINT-2", now: t2 });
    await appendRunCost(path, { runCostUsd: 5.0, issueKey: "FINT-3", now: other });

    expect(await readDayCost(path, "2026-01-01")).toBe(2.0);
    expect(await readDayCost(path, "2026-01-02")).toBe(5.0);
    expect(await readDayCost(path, "2026-01-03")).toBe(0);
  });

  it("returns 0 for a missing ledger", async () => {
    expect(await readDayCost(join(dir, "nope.jsonl"))).toBe(0);
  });

  it("honours the MANSO_COST_LEDGER override", () => {
    const prev = process.env.MANSO_COST_LEDGER;
    process.env.MANSO_COST_LEDGER = "/tmp/custom-ledger.jsonl";
    try {
      expect(costLedgerPath("/ignored")).toBe("/tmp/custom-ledger.jsonl");
    } finally {
      if (prev === undefined) delete process.env.MANSO_COST_LEDGER;
      else process.env.MANSO_COST_LEDGER = prev;
    }
  });

  it("ledgerDay yields YYYY-MM-DD", () => {
    expect(ledgerDay(new Date("2026-05-29T23:59:00.000Z"))).toBe("2026-05-29");
  });

  it("a recorded day total over the cap is a day breach (M15 wiring)", async () => {
    const path = join(dir, "cost-ledger.jsonl");
    await appendRunCost(path, { runCostUsd: 24, now: () => new Date("2026-01-01T09:00:00.000Z") });
    const dayCost = await readDayCost(path, "2026-01-01");
    const decision = checkBudget({ budget: { maxCostPerDayUsd: 20 }, runCostUsd: 0, dayCostUsd: dayCost });
    expect(decision.ok).toBe(false);
    expect(decision.breaches[0]?.scope).toBe("day");
  });
});
