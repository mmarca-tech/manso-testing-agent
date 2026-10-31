import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/shared/concurrency.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapWithConcurrency", () => {
  it("never runs more than `limit` calls at once and keeps input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([30, 5, 20, 1, 10], 2, async (ms, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(ms);
      inFlight -= 1;
      return index;
    });

    expect(peak).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4].map((value) => ({ ok: true, value })));
  });

  it("keeps going after a rejection and reports it in place", async () => {
    const results = await mapWithConcurrency(["a", "boom", "c"], 3, async (item) => {
      if (item === "boom") throw new Error("failed");
      return item.toUpperCase();
    });

    expect(results[0]).toEqual({ ok: true, value: "A" });
    expect(results[1]?.ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: "C" });
  });

  it("handles an empty list and clamps a nonsensical limit to 1", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n * 2)).toEqual([
      { ok: true, value: 2 },
      { ok: true, value: 4 },
    ]);
  });
});
