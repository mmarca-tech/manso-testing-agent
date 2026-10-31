/**
 * Leaf telemetry-state flag — deliberately free of any OpenTelemetry imports.
 *
 * A short-lived CLI must flush buffered spans before it exits, but it should
 * not pay the cost of loading the OpenTelemetry/OpenInference stack for
 * lightweight verbs (`--version`, `init`, `check`) that never emit traces.
 * `initializeTelemetry()` flips this flag on once it activates a provider, so
 * the CLI entrypoint can cheaply check it and only then dynamically import the
 * heavy {@link flushTelemetry}.
 */

let active = false;

/** Called by `initializeTelemetry` once a tracer provider is registered. */
export function markTelemetryActive(): void {
  active = true;
}

/** True when telemetry was activated during this process. */
export function isTelemetryActive(): boolean {
  return active;
}
