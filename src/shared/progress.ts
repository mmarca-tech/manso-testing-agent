/** The slice of a Node stream the reporter needs; `process.stderr` satisfies it. */
export interface ProgressStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface ProgressReporterOptions {
  /** Shown before the bar, e.g. "ITSM 2026-10". */
  label: string;
  total: number;
  stream: ProgressStream;
  /** Injected for tests. */
  now?: () => number;
  /** Redraw interval on a TTY, so elapsed time keeps moving between completions. 0 disables. */
  refreshMs?: number;
}

const BAR_WIDTH = 24;

/**
 * Progress for a batch of long-running items. On a TTY it keeps one live line
 * (bar, counts, running, elapsed, ETA, last item) and prints notable events
 * (failures) on their own lines above it. On a non-TTY (CI logs) it writes one
 * plain line per completed item instead: redrawn lines turn into noise there.
 */
export class ProgressReporter {
  private readonly label: string;
  private readonly total: number;
  private readonly stream: ProgressStream;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly tty: boolean;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private done = 0;
  private failed = 0;
  private running = 0;
  private last: string | undefined;
  private finished = false;

  constructor(options: ProgressReporterOptions) {
    this.label = options.label;
    this.total = options.total;
    this.stream = options.stream;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.tty = Boolean(options.stream.isTTY);
    const refreshMs = options.refreshMs ?? 1000;
    if (this.tty && refreshMs > 0 && this.total > 0) {
      this.timer = setInterval(() => this.redraw(), refreshMs);
      // Never keep the process alive just to animate the bar.
      this.timer.unref?.();
    }
    this.redraw();
  }

  /** An item started (counts towards "running"). */
  start(): void {
    this.running += 1;
    this.redraw();
  }

  /** An item finished. `detail` is e.g. its duration or the failure reason. */
  complete(item: string, ok: boolean, detail?: string): void {
    this.running = Math.max(0, this.running - 1);
    this.done += 1;
    if (!ok) this.failed += 1;
    this.last = item;
    const position = `[${this.done}/${this.total}]`;
    if (!this.tty) {
      this.stream.write(`${position} ${item} ${ok ? "done" : "FAILED"}${detail ? ` (${detail})` : ""} · ${this.timing()}\n`);
      return;
    }
    if (!ok) this.note(`✗ ${position} ${item} failed${detail ? `: ${detail}` : ""}`);
    this.redraw();
  }

  /** A message that must stay visible (printed above the bar on a TTY). */
  note(message: string): void {
    if (this.tty) {
      this.stream.write(`\r\x1b[2K${message}\n`);
      this.redraw();
    } else {
      this.stream.write(`${message}\n`);
    }
  }

  /** Stop redrawing and leave the final bar on screen. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    if (this.tty) {
      this.redraw(true);
      this.stream.write("\n");
    }
  }

  /** The live line, exposed for tests. */
  line(): string {
    const ratio = this.total > 0 ? this.done / this.total : 1;
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
    const parts = [
      `${this.label} [${bar}] ${this.done}/${this.total} ${Math.floor(ratio * 100)}%`,
      `✓${this.done - this.failed} ✗${this.failed}`,
      ...(this.running > 0 ? [`${this.running} running`] : []),
      this.timing(),
      ...(this.last ? [`last ${this.last}`] : []),
    ];
    return parts.join(" · ");
  }

  private timing(): string {
    const elapsed = this.now() - this.startedAt;
    const remaining = this.total - this.done;
    const eta =
      this.done > 0 && remaining > 0 ? ` · ETA ~${formatDuration((elapsed / this.done) * remaining)}` : "";
    return `${formatDuration(elapsed)} elapsed${eta}`;
  }

  private redraw(force = false): void {
    if (!this.tty || (this.finished && !force)) return;
    // Keep within one terminal row: a wrapped line cannot be redrawn with \r.
    const max = Math.max(20, (this.stream.columns ?? 120) - 1);
    const text = this.line();
    this.stream.write(`\r\x1b[2K${text.length > max ? `${text.slice(0, max - 1)}…` : text}`);
  }
}

/** 42s, 6m 05s, 1h 12m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
