import type { Timing } from "./types.js";
import { abortReason, now, timerDelay, type Timer } from "./util.js";

/**
 * The backoff before retry number `n` (1, 2, 3 ...): base, 2x, 4x ... up to the maximum, plus up to 25%
 * jitter on top (never less than the step, so a minimum gap stays a minimum).
 */
export function backoffMs(timing: Timing, n: number): number {
  const step = Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** (n - 1));
  const jitter = Math.min(Math.max(timing.random(), 0), 1);
  return step * (1 + 0.25 * jitter);
}

/** How an attempt on /completed ended. The gate turns it into the wait before the next attempt. */
export type Outcome =
  /** An answer with results; `full` when it was a full page of 100. */
  | { kind: "ok"; full: boolean }
  /** 408, 429, 5xx, a dropped connection, an unreadable answer. */
  | { kind: "failure"; retryAfterMs?: number }
  /** 401: the key was rejected, or the user's Mailman isn't connected. */
  | { kind: "unauthorized" }
  /** The caller's own signal ended the attempt. */
  | { kind: "aborted" }
  /** The slot was taken but no request was sent. */
  | { kind: "skipped" };

interface Queued {
  resolve(lease: Lease): void;
  reject(reason: unknown): void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/** Permission for exactly one attempt. Report how it ended with `done` (a second call does nothing). */
export class Lease {
  #finished = false;

  constructor(private readonly gate: PollGate) {}

  get finished(): boolean {
    return this.#finished;
  }

  done(outcome: Outcome): void {
    if (this.#finished) return;
    this.#finished = true;
    this.gate.release(outcome);
  }

  /** Give the slot back without sending anything; pacing is unchanged. */
  skip(): void {
    this.done({ kind: "skipped" });
  }
}

/**
 * The one place that decides when the next request on a group's /completed may start.
 * Everything that paces a group lives here, not in a loop's local variables: the poll
 * interval, Retry-After, the backoff and the 401 delay. A poller, a restarted poller, a
 * direct `poll()` and every retry all go through `acquire`, so no two attempts on one group
 * are ever closer than the longest of the applicable waits.
 *
 * Attempts are strictly serial and FIFO, and the wait counts from the END of the previous
 * attempt, so the gap between two requests is never shorter than the wait.
 */
export class PollGate {
  #notBefore = 0;
  #failures = 0;
  #busy = false;
  #queue: Queued[] = [];
  #timer: Timer | undefined;

  constructor(private readonly timing: Timing) {}

  get busy(): boolean {
    return this.#busy;
  }

  get queued(): number {
    return this.#queue.length;
  }

  /** Monotonic time after which the gate holds nothing worth remembering: pacing is over and failures are forgotten. */
  get idleAfter(): number {
    return this.#notBefore + (this.#failures > 0 ? this.timing.backoffMaxMs : 0);
  }

  /** Resolves with a lease when an attempt may start. Rejects with the abort reason if `signal` fires first. */
  acquire(signal?: AbortSignal): Promise<Lease> {
    return new Promise<Lease>((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal));
      const entry: Queued = { resolve, reject, signal, onAbort: undefined };
      if (signal) {
        entry.onAbort = () => {
          const at = this.#queue.indexOf(entry);
          if (at < 0) return;
          this.#queue.splice(at, 1);
          if (this.#queue.length === 0) this.#clearTimer();
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.#queue.push(entry);
      this.#pump();
    });
  }

  /** @internal Called by `Lease.done`. */
  release(outcome: Outcome): void {
    const end = now();
    let delay: number;
    try {
      delay = this.#delayAfter(outcome);
    } catch (error) {
      // Whatever went wrong computing the wait (a failing jitter source), the gate must not stay busy.
      this.#settle(end + this.timing.pollIntervalMs);
      throw error;
    }
    this.#settle(outcome.kind === "skipped" ? this.#notBefore : end + delay);
  }

  #delayAfter(outcome: Outcome): number {
    const t = this.timing;
    switch (outcome.kind) {
      case "ok":
        this.#failures = 0;
        return outcome.full ? t.fullPageIntervalMs : t.pollIntervalMs;
      case "failure":
        this.#failures += 1;
        // The longest of: the normal interval, Retry-After, and the backoff.
        return Math.max(t.pollIntervalMs, outcome.retryAfterMs ?? 0, backoffMs(t, this.#failures));
      case "unauthorized":
        return Math.max(t.pollIntervalMs, t.unauthorizedDelayMs);
      case "aborted":
        return t.pollIntervalMs;
      case "skipped":
        return 0;
    }
  }

  #settle(notBefore: number): void {
    this.#notBefore = notBefore;
    this.#busy = false;
    this.#pump();
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #pump(): void {
    if (this.#busy || this.#timer !== undefined) return;
    const head = this.#queue[0];
    if (!head) return;
    const wait = this.#notBefore - now();
    if (wait > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#pump();
      }, timerDelay(wait));
      return;
    }
    this.#queue.shift();
    if (head.signal && head.onAbort) head.signal.removeEventListener("abort", head.onAbort);
    this.#busy = true;
    head.resolve(new Lease(this));
  }
}
