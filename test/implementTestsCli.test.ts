import { describe, expect, it } from "vitest";
import command from "../src/cli/implementTests.js";
import { CliError } from "../src/shared/cli.js";

describe("implement-tests argument validation", () => {
  it("rejects when both --design and --issue are given", async () => {
    await expect(command.run(["--repo", "/tmp/x", "--design", "d.json", "--issue", "ABC-1"])).rejects.toBeInstanceOf(CliError);
  });

  it("rejects when neither --design nor --issue is given", async () => {
    await expect(command.run(["--repo", "/tmp/x"])).rejects.toBeInstanceOf(CliError);
  });

  it("rejects when --repo is missing", async () => {
    await expect(command.run(["--issue", "ABC-1"])).rejects.toBeInstanceOf(CliError);
  });
});
