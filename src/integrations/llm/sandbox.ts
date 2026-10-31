/**
 * Sandbox policy seam (M13d).
 *
 * The code-agent runners previously hard-coded the most permissive execution
 * settings (`danger-full-access`, `bypassPermissions`). That was flagged debt:
 * fine for a trusted local run, dangerous as an invisible default. This module
 * makes the policy an explicit, named, overridable profile so an operator can
 * dial it down (e.g. in CI) without touching the runners — and so a future
 * devcontainer/Dagger sandbox can map onto the same profiles.
 *
 * Default remains `danger-full-access` to preserve existing behaviour; override
 * with `MANSO_SANDBOX=workspace-write|read-only|danger-full-access`.
 */

import type { ApprovalMode, SandboxMode } from "@openai/codex-sdk";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export const SANDBOX_PROFILES = ["danger-full-access", "workspace-write", "read-only"] as const;
export type SandboxProfile = (typeof SANDBOX_PROFILES)[number];

export const DEFAULT_SANDBOX_PROFILE: SandboxProfile = "danger-full-access";

export interface CodexSandboxSettings {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  networkAccessEnabled: boolean;
}

export interface ClaudeSandboxSettings {
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
}

const CODEX_BY_PROFILE: Record<SandboxProfile, CodexSandboxSettings> = {
  "danger-full-access": { sandboxMode: "danger-full-access", approvalPolicy: "never", networkAccessEnabled: true },
  "workspace-write": { sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: true },
  "read-only": { sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false },
};

const CLAUDE_BY_PROFILE: Record<SandboxProfile, ClaudeSandboxSettings> = {
  "danger-full-access": { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
  "workspace-write": { permissionMode: "acceptEdits", allowDangerouslySkipPermissions: false },
  "read-only": { permissionMode: "default", allowDangerouslySkipPermissions: false },
};

export function isSandboxProfile(value: string): value is SandboxProfile {
  return (SANDBOX_PROFILES as readonly string[]).includes(value);
}

/**
 * Resolve the active sandbox profile from an explicit value, then the
 * `MANSO_SANDBOX` env var, then the default. An unrecognised value falls
 * back to the default rather than throwing, so a typo never blocks a run.
 */
export function resolveSandboxProfile(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): SandboxProfile {
  const candidate = explicit ?? env.MANSO_SANDBOX;
  if (candidate && isSandboxProfile(candidate.trim())) {
    return candidate.trim() as SandboxProfile;
  }
  return DEFAULT_SANDBOX_PROFILE;
}

export function codexSandboxSettings(profile: SandboxProfile): CodexSandboxSettings {
  return CODEX_BY_PROFILE[profile];
}

export function claudeSandboxSettings(profile: SandboxProfile): ClaudeSandboxSettings {
  return CLAUDE_BY_PROFILE[profile];
}
