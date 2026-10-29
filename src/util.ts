/**
 * Monotonic milliseconds. Every deadline and pacing decision uses this, never `Date.now()`:
 * a wall-clock jump (NTP, DST, a user changing the time) must not stretch or cut a wait.
 */
export const now = (): number => performance.now();

export type Timer = ReturnType<typeof setTimeout>;

/** A delay `setTimeout` accepts: at least 1 ms, at most 2^31-1 (it fires early and loops past that). */
export const timerDelay = (ms: number): number => Math.min(Math.max(Math.ceil(ms), 1), 2_147_483_647);

/** Let the process exit while only this timer is pending. */
export function unrefTimer(timer: Timer): Timer {
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/** Make the process wait for this timer again. */
export function refTimer(timer: Timer): Timer {
  (timer as unknown as { ref?: () => void }).ref?.();
  return timer;
}

/** What an aborted `signal` should reject with: its reason, or an AbortError. */
export function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * `promise`, unless `signal` fires first: then a rejection with the abort reason, at once. The promise itself is not
 * touched and runs to its end; only this caller stops waiting for it.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);
    promise.then(
      (value) => (done(), resolve(value)),
      (error) => (done(), reject(error)),
    );
  });
}

/**
 * Sleep for `ms` on the monotonic clock (never wakes early), rejecting with the abort reason
 * as soon as `signal` fires.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const until = now() + ms;
    let timer: Timer | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const tick = () => {
      const left = until - now();
      if (left > 0) {
        timer = setTimeout(tick, timerDelay(left));
        return;
      }
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    tick();
  });
}

/**
 * A signal that aborts, with the same reason, as soon as any of `signals` does. `dispose` detaches it
 * from them; call it when the work is done, so a long-lived signal doesn't collect listeners.
 */
export function anySignal(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal | undefined; dispose(): void } {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (live.length < 2) return { signal: live[0], dispose: () => undefined };
  const controller = new AbortController();
  const detach: Array<() => void> = [];
  const dispose = () => {
    for (const off of detach.splice(0)) off();
  };
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      dispose();
      break;
    }
    const onAbort = () => {
      controller.abort(signal.reason);
      dispose();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    detach.push(() => signal.removeEventListener("abort", onAbort));
  }
  return { signal: controller.signal, dispose };
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
