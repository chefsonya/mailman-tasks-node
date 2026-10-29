import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffMs, PollGate, type Outcome } from "../src/gate.js";
import type { Timing } from "../src/index.js";
import { gaps, sleep, TOLERANCE } from "./support/harness.js";

const timing = (overrides: Partial<Timing> = {}): Timing => ({
  pollIntervalMs: 60,
  fullPageIntervalMs: 15,
  unauthorizedDelayMs: 120,
  backoffBaseMs: 20,
  backoffMaxMs: 160,
  deadlineGraceMs: 0,
  maxCreateAttempts: 3,
  maxRetryAfterMs: 60_000,
  random: () => 0,
  ...overrides,
});

/** Run one attempt per outcome through a gate; returns when each attempt was allowed to start. */
async function drive(gate: PollGate, outcomes: Outcome[]): Promise<number[]> {
  const starts: number[] = [];
  for (const outcome of outcomes) {
    const lease = await gate.acquire();
    starts.push(performance.now());
    lease.done(outcome);
  }
  starts.push(performance.now());
  const last = await gate.acquire();
  starts[starts.length - 1] = performance.now();
  last.skip();
  return starts;
}

describe("PollGate: how long after each outcome", () => {
  it("the first attempt starts at once", async () => {
    const gate = new PollGate(timing({ pollIntervalMs: 2000 }));
    const started = performance.now();
    (await gate.acquire()).skip();
    assert.ok(performance.now() - started < 1000, "waited for an interval nobody had started");
  });

  it("waits the poll interval after a page, and the shorter full-page interval after 100 results", async () => {
    const [afterPage, afterFull] = gaps(
      await drive(new PollGate(timing({ pollIntervalMs: 200, fullPageIntervalMs: 20 })), [{ kind: "ok", full: false }, { kind: "ok", full: true }]),
    );
    assert.ok(afterPage! >= 200 - TOLERANCE, `after a page: ${afterPage}`);
    assert.ok(afterFull! >= 20 - TOLERANCE && afterFull! < 150, `after a full page: ${afterFull}`);
  });

  it("waits the longest of the interval, Retry-After and the backoff after a failure", async () => {
    const wait = async (t: Partial<Timing>, retryAfterMs?: number) => {
      const [gap] = gaps(await drive(new PollGate(timing(t)), [{ kind: "failure", retryAfterMs }]));
      return gap!;
    };
    // interval 200 > backoff 20 > Retry-After 50
    assert.ok((await wait({ pollIntervalMs: 200 }, 50)) >= 200 - TOLERANCE, "the interval wins");
    // Retry-After 250 > interval 60
    assert.ok((await wait({}, 250)) >= 250 - TOLERANCE, "Retry-After wins");
    // backoff 150 > interval 60 > Retry-After 40
    assert.ok((await wait({ backoffBaseMs: 150, backoffMaxMs: 400 }, 40)) >= 150 - TOLERANCE, "the backoff wins");
  });

  it("a Retry-After shorter than the interval never shortens it", async () => {
    const [gap] = gaps(await drive(new PollGate(timing({ pollIntervalMs: 300 })), [{ kind: "failure", retryAfterMs: 100 }]));
    assert.ok(gap! >= 300 - TOLERANCE, `re-polled after ${gap}`);
  });

  it("doubles the backoff per consecutive failure, up to the maximum, and forgets it after a success", async () => {
    const g = timing({ pollIntervalMs: 5, backoffBaseMs: 30, backoffMaxMs: 100 });
    const failure: Outcome = { kind: "failure" };
    const all = gaps(await drive(new PollGate(g), [failure, failure, failure, failure, { kind: "ok", full: false }, failure]));
    const [first, second, third, fourth, , afterSuccess] = all;
    assert.ok(first! >= 30 - TOLERANCE && first! < 100, `1st ${first}`);
    assert.ok(second! >= 60 - TOLERANCE, `2nd ${second}`);
    assert.ok(third! >= 100 - TOLERANCE, `3rd ${third} (capped at 100, not 120)`);
    assert.ok(fourth! >= 100 - TOLERANCE && fourth! < 160, `4th ${fourth}`);
    assert.ok(afterSuccess! >= 30 - TOLERANCE && afterSuccess! < 100, `after a success the backoff starts over: ${afterSuccess}`);
  });

  it("waits the 401 delay after an unauthorized answer, and doesn't escalate it", async () => {
    const [a, b] = gaps(await drive(new PollGate(timing({ unauthorizedDelayMs: 150, backoffBaseMs: 10 })), [{ kind: "unauthorized" }, { kind: "unauthorized" }]));
    for (const gap of [a!, b!]) assert.ok(gap >= 150 - TOLERANCE && gap < 400, `gap ${gap}`);
  });

  it("an aborted attempt still costs the interval; a skipped one costs nothing", async () => {
    const [aborted] = gaps(await drive(new PollGate(timing({ pollIntervalMs: 120 })), [{ kind: "aborted" }]));
    assert.ok(aborted! >= 120 - TOLERANCE);
    const [skipped] = gaps(await drive(new PollGate(timing({ pollIntervalMs: 300 })), [{ kind: "skipped" }]));
    assert.ok(skipped! < 100, `skip took ${skipped}`);
  });

  it("jitter only adds to the backoff: between the step and 125% of it", () => {
    const low = backoffMs(timing({ random: () => 0 }), 3);
    const high = backoffMs(timing({ random: () => 1 }), 3);
    assert.equal(low, 80);
    assert.equal(high, 100);
    assert.equal(backoffMs(timing({ random: () => 0.5 }), 20), 160 * 1.125);
    // A broken jitter source can't push it outside the range.
    assert.equal(backoffMs(timing({ random: () => 7 }), 1), 25);
    assert.equal(backoffMs(timing({ random: () => -3 }), 1), 20);
  });
});

describe("PollGate: serial, fair, cancellable", () => {
  it("never lets two attempts run at once, and serves callers in order", async () => {
    const gate = new PollGate(timing({ pollIntervalMs: 20 }));
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map(async (n) => {
        const lease = await gate.acquire();
        running++;
        peak = Math.max(peak, running);
        order.push(n);
        await sleep(5);
        running--;
        lease.done({ kind: "ok", full: false });
      }),
    );
    assert.equal(peak, 1);
    assert.deepEqual(order, [0, 1, 2, 3]);
  });

  it("keeps the gap between attempts for every caller, not just the first", async () => {
    const gate = new PollGate(timing({ pollIntervalMs: 50 }));
    const starts: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        const lease = await gate.acquire();
        starts.push(performance.now());
        lease.done({ kind: "ok", full: false });
      }),
    );
    for (const gap of gaps(starts)) assert.ok(gap >= 50 - TOLERANCE, `gap ${gap}`);
  });

  it("done() twice counts once", async () => {
    const gate = new PollGate(timing({ pollIntervalMs: 100 }));
    const lease = await gate.acquire();
    lease.done({ kind: "ok", full: false });
    lease.done({ kind: "failure" });
    assert.equal(lease.finished, true);
    const started = performance.now();
    (await gate.acquire()).skip();
    const waited = performance.now() - started;
    assert.ok(waited >= 100 - TOLERANCE && waited < 400, `waited ${waited} (a failure's backoff would be longer)`);
  });

  it("a caller that aborts while queued leaves without a trace", async () => {
    const gate = new PollGate(timing({ pollIntervalMs: 100 }));
    const first = await gate.acquire();
    const controller = new AbortController();
    const queued = gate.acquire(controller.signal);
    assert.equal(gate.queued, 1);
    controller.abort(new Error("changed my mind"));
    await assert.rejects(queued, /changed my mind/);
    assert.equal(gate.queued, 0);
    first.done({ kind: "ok", full: false });
    const next = await gate.acquire();
    next.skip();
    assert.equal(gate.busy, false);
  });

  it("an already aborted signal is rejected at once", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(new PollGate(timing()).acquire(controller.signal), (error: unknown) => (error as Error).name === "AbortError");
  });

  it("still releases the gate when the jitter source throws, and reports the error", async () => {
    const gate = new PollGate(timing({ pollIntervalMs: 30, random: () => { throw new Error("no randomness today"); } }));
    const lease = await gate.acquire();
    assert.throws(() => lease.done({ kind: "failure" }), /no randomness today/);
    assert.equal(gate.busy, false);
    const started = performance.now();
    (await gate.acquire()).skip();
    assert.ok(performance.now() - started >= 30 - TOLERANCE, "the interval still applies");
  });

  it("reports when it holds nothing worth keeping", async () => {
    const gate = new PollGate(timing({ pollIntervalMs: 50, backoffMaxMs: 200 }));
    const lease = await gate.acquire();
    lease.done({ kind: "ok", full: false });
    assert.ok(gate.idleAfter > performance.now(), "pacing is still running");
    assert.ok(gate.idleAfter <= performance.now() + 50 + 5);
    const failing = new PollGate(timing({ pollIntervalMs: 50, backoffMaxMs: 200 }));
    (await failing.acquire()).done({ kind: "failure" });
    assert.ok(failing.idleAfter >= performance.now() + 200, "failures are remembered for one maximum backoff");
  });
});
