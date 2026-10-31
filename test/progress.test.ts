import { describe, expect, it } from "vitest";
import { formatDuration, ProgressReporter, type ProgressStream } from "../src/shared/progress.js";

function fakeStream(isTTY: boolean, columns?: number): ProgressStream & { out: string } {
  const stream = {
    out: "",
    isTTY,
    ...(columns ? { columns } : {}),
    write(chunk: string) {
      stream.out += chunk;
      return true;
    },
  };
  return stream;
}

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [42_000, "42s"],
    [365_000, "6m 05s"],
    [4_320_000, "1h 12m"],
  ])("formats %d ms as %j", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("ProgressReporter", () => {
  it("on a TTY draws one live line with counts, running, elapsed, ETA and the last item", () => {
    const stream = fakeStream(true);
    const time = clock();
    const reporter = new ProgressReporter({ label: "ITSM 2026-10", total: 4, stream, now: time.now, refreshMs: 0 });

    reporter.start();
    reporter.start();
    time.advance(60_000);
    reporter.complete("ITSM-1", true);

    expect(reporter.line()).toBe(
      "ITSM 2026-10 [██████░░░░░░░░░░░░░░░░░░] 1/4 25% · ✓1 ✗0 · 1 running · 1m 00s elapsed · ETA ~3m 00s · last ITSM-1",
    );
    // Redrawn in place, never a newline while running.
    expect(stream.out).toContain("\r\x1b[2K");
    expect(stream.out).not.toContain("\n");
  });

  it("prints failures on their own line above the bar, and ends with a newline", () => {
    const stream = fakeStream(true);
    const reporter = new ProgressReporter({ label: "M", total: 2, stream, now: clock().now, refreshMs: 0 });
    reporter.start();
    reporter.complete("ITSM-2", false, "jira REST 500");
    reporter.finish();
    reporter.finish();

    expect(stream.out).toContain("\r\x1b[2K✗ [1/2] ITSM-2 failed: jira REST 500\n");
    expect(stream.out.endsWith("\n")).toBe(true);
    expect(stream.out.match(/\n/g)).toHaveLength(2);
  });

  it("truncates the live line to the terminal width so it never wraps", () => {
    const stream = fakeStream(true, 40);
    new ProgressReporter({ label: "A very long label for a narrow terminal", total: 3, stream, now: clock().now, refreshMs: 0 });
    const drawn = stream.out.split("\r\x1b[2K").pop()!;
    expect(drawn.length).toBe(39);
    expect(drawn.endsWith("…")).toBe(true);
  });

  it("on a non-TTY writes one plain line per completed item and no control codes", () => {
    const stream = fakeStream(false);
    const time = clock();
    const reporter = new ProgressReporter({ label: "ITSM 2026-10", total: 2, stream, now: time.now });
    reporter.start();
    time.advance(30_000);
    reporter.complete("ITSM-1", true, "30s, 3 row(s)");
    reporter.complete("ITSM-2", false, "boom");
    reporter.finish();

    expect(stream.out).toBe(
      "[1/2] ITSM-1 done (30s, 3 row(s)) · 30s elapsed · ETA ~30s\n" + "[2/2] ITSM-2 FAILED (boom) · 30s elapsed\n",
    );
  });
});
