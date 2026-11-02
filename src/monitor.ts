import type { UsageSnapshot, UsageState } from "./types.ts";

export const REFRESH_INTERVAL_MS = 60_000;
export const RENDER_INTERVAL_MS = 15_000;

export interface MonitorOptions {
  load: (signal: AbortSignal) => Promise<UsageSnapshot>;
  onChange?: (state: UsageState) => void;
  now?: () => number;
  refreshIntervalMs?: number;
  renderIntervalMs?: number;
}

/** Session-scoped polling, shared by commands, the sidebar, and the tool. */
export class UsageMonitor {
  private state: UsageState = { loading: false };
  private inFlight?: Promise<UsageState>;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private lastAttempt = -Infinity;
  private generation = 0;
  private stopped = false;
  private readonly options: MonitorOptions;

  constructor(options: MonitorOptions) {
    this.options = options;
  }

  getState(): UsageState {
    return this.state;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private changed(): void {
    this.options.onChange?.(this.state);
  }

  start(poll = true): void {
    this.stopped = false;
    if (!poll || this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh();
      this.changed(); // Repaint reset countdowns, even when the cache is fresh.
    }, this.options.renderIntervalMs ?? RENDER_INTERVAL_MS);
    this.timer.unref?.();
    void this.refresh(true);
  }

  refresh(force = false): Promise<UsageState> {
    if (this.stopped) return Promise.resolve(this.state);
    if (this.inFlight) return this.inFlight;
    if (!force && this.now() - this.lastAttempt < (this.options.refreshIntervalMs ?? REFRESH_INTERVAL_MS)) {
      return Promise.resolve(this.state);
    }

    const generation = this.generation;
    const cancelledState = { ...this.state, loading: false };
    const controller = new AbortController();
    this.controller = controller;
    this.lastAttempt = this.now();
    this.state = { ...this.state, loading: true };
    this.changed();

    this.inFlight = (async () => {
      // Yield before invoking an injected loader that might throw synchronously.
      await Promise.resolve();
      try {
        controller.signal.throwIfAborted();
        const snapshot = await this.options.load(controller.signal);
        if (generation !== this.generation) return cancelledState;
        this.state = { snapshot, loading: false, updatedAt: this.now() };
      } catch (error) {
        if (generation !== this.generation) return cancelledState;
        this.state = {
          ...this.state,
          loading: false,
          error: error instanceof Error ? error.message : "OpenAI usage lookup failed",
        };
      } finally {
        if (generation === this.generation) {
          this.controller = undefined;
          this.inFlight = undefined;
          this.changed();
        }
      }
      return this.state;
    })();
    return this.inFlight;
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.inFlight = undefined;
    this.lastAttempt = -Infinity;
    this.state = { ...this.state, loading: false };
  }
}
