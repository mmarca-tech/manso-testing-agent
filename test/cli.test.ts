import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/main.js";
import { readVersion } from "../src/cli/version.js";

describe("readVersion", () => {
  it("returns the version declared in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(readVersion()).toBe(pkg.version);
  });
});

describe("runCli", () => {
  it("prints help and exits 0 when given no arguments", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli([]);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("prints help for --help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("prints the package version for --version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(readVersion());
    log.mockRestore();
  });

  it("exits 1 and reports an unknown command", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runCli(["definitely-not-a-command"]);
    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown command"),
    );
    error.mockRestore();
  });
});
