import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRedactor, redactText, REDACTION_PLACEHOLDER } from "../src/policy/redaction.js";
import { checkBudget, sumUsageCost } from "../src/policy/budget.js";
import { appendAuditEntry, readAuditLog } from "../src/policy/auditLog.js";

describe("redaction", () => {
  it("redacts common secret shapes", () => {
    const r = buildRedactor();
    expect(r.redact("key sk-ant-abcdefghijklmnopqrstuvwx")).toContain(REDACTION_PLACEHOLDER);
    expect(r.redact("Authorization: Bearer abcdef1234567890")).toContain(REDACTION_PLACEHOLDER);
    expect(r.redact("contact me at jane.doe@example.com")).toContain(REDACTION_PLACEHOLDER);
    expect(r.redact("password=hunter2secret")).toContain(REDACTION_PLACEHOLDER);
  });

  it("applies custom patterns and skips invalid ones without throwing", () => {
    const r = buildRedactor(["ACME-\\d{4}", "(((invalid"]);
    expect(r.redact("ticket ACME-1234 done")).toBe(`ticket ${REDACTION_PLACEHOLDER} done`);
  });

  it("leaves clean text untouched and redacts record string values", () => {
    expect(redactText("nothing secret here")).toBe("nothing secret here");
    const record = buildRedactor().redactRecord({ note: "token=supersecretvalue", count: 3 });
    expect(record.note).toContain(REDACTION_PLACEHOLDER);
    expect(record.count).toBe(3);
  });
});

describe("checkBudget", () => {
  it("passes when under both limits", () => {
    const decision = checkBudget({ budget: { maxCostPerRunUsd: 5, maxCostPerDayUsd: 50 }, runCostUsd: 1.2, dayCostUsd: 10 });
    expect(decision.ok).toBe(true);
    expect(decision.breaches).toEqual([]);
  });

  it("flags a run breach", () => {
    const decision = checkBudget({ budget: { maxCostPerRunUsd: 1 }, runCostUsd: 2.5 });
    expect(decision.ok).toBe(false);
    expect(decision.breaches[0]).toMatchObject({ scope: "run", limitUsd: 1 });
    expect(decision.message).toMatch(/run cost/);
  });

  it("flags a day breach only when a day total is supplied", () => {
    expect(checkBudget({ budget: { maxCostPerDayUsd: 10 }, runCostUsd: 1 }).ok).toBe(true);
    expect(checkBudget({ budget: { maxCostPerDayUsd: 10 }, runCostUsd: 1, dayCostUsd: 12 }).ok).toBe(false);
  });

  it("sums usage cost across agents", () => {
    expect(sumUsageCost([{ provider: "anthropic", totalCostUsd: 0.5 }, { provider: "openai" }, undefined])).toBe(0.5);
  });
});

describe("audit log", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "manso-audit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends redacted JSONL entries that round-trip", async () => {
    const path = join(dir, "nested", "audit.jsonl");
    await appendAuditEntry({
      path,
      action: "pr.raised",
      actor: "cli",
      target: "QATG-1",
      detail: { url: "https://dev.azure.com/pr/1", secret: "token=supersecretvalue" },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await appendAuditEntry({ path, action: "run.completed", actor: "cli", target: "QATG-1" });

    const entries = await readAuditLog(path);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.action).toBe("pr.raised");
    expect(String(entries[0]?.detail?.secret)).toContain(REDACTION_PLACEHOLDER);
    expect(entries[1]?.action).toBe("run.completed");
  });

  it("returns an empty array for a missing log", async () => {
    expect(await readAuditLog(join(dir, "nope.jsonl"))).toEqual([]);
  });
});
