import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_PROFILE,
  claudeSandboxSettings,
  codexSandboxSettings,
  isSandboxProfile,
  resolveSandboxProfile,
} from "../src/integrations/llm/sandbox.js";

describe("resolveSandboxProfile", () => {
  it("defaults to danger-full-access to preserve existing behaviour", () => {
    expect(resolveSandboxProfile(undefined, {} as NodeJS.ProcessEnv)).toBe("danger-full-access");
    expect(DEFAULT_SANDBOX_PROFILE).toBe("danger-full-access");
  });

  it("reads MANSO_SANDBOX from the environment", () => {
    expect(resolveSandboxProfile(undefined, { MANSO_SANDBOX: "read-only" } as NodeJS.ProcessEnv)).toBe("read-only");
  });

  it("prefers an explicit value over the environment", () => {
    expect(resolveSandboxProfile("workspace-write", { MANSO_SANDBOX: "read-only" } as NodeJS.ProcessEnv)).toBe("workspace-write");
  });

  it("falls back to the default on an unrecognised value (never throws)", () => {
    expect(resolveSandboxProfile("bogus", {} as NodeJS.ProcessEnv)).toBe("danger-full-access");
  });

  it("validates known profiles", () => {
    expect(isSandboxProfile("read-only")).toBe(true);
    expect(isSandboxProfile("nope")).toBe(false);
  });
});

describe("sandbox settings mapping", () => {
  it("maps the permissive profile to the prior hard-coded settings", () => {
    expect(codexSandboxSettings("danger-full-access")).toEqual({
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
    });
    expect(claudeSandboxSettings("danger-full-access")).toEqual({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });

  it("dials network + permissions down for read-only", () => {
    expect(codexSandboxSettings("read-only").networkAccessEnabled).toBe(false);
    expect(claudeSandboxSettings("read-only").allowDangerouslySkipPermissions).toBe(false);
  });

  it("uses a middle ground for workspace-write", () => {
    expect(codexSandboxSettings("workspace-write").sandboxMode).toBe("workspace-write");
    expect(claudeSandboxSettings("workspace-write").permissionMode).toBe("acceptEdits");
  });
});
