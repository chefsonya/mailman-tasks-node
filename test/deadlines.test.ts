import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NetworkError, TaskTimeoutError } from "../src/index.js";
import { FAST, gaps, harness, sleep, task, TOLERANCE, until } from "./support/harness.js";
import type { MockApi } from "./support/mock-api.js";

const ok = (code: string) => ({ status: "success" as const, results: { code } });

/** Runs `body` with the wall clock stubbed by `offsetMs`, always restoring it. */
async function withClockJump(offsetMs: () => number, body: () => Promise<void>): Promise<void> {
  const real = Date.now;
  try {
    Date.now = () => real() + offsetMs();
    await body();
  } finally {
    Date.now = real;
  }
}

// These tests stub Date.now, a global: they run one at a time (no `concurrency`), in their own file. None of them
// depends on a tight timing window. The test drives the loop with events (a response held at the server and released
// on cue, a poll arriving) and every bound is generous: a bug shows as "never ended" or "ended early", not as a race.
describe("deadlines run on a monotonic clock", () => {
  /** Hold the next poll at the server until the returned function is called. */
  const holdNextPoll = (api: MockApi): (() => void) => {
    let release: () => void = () => undefined;
    api.fail("completed", { kind: "hold", release: new Promise<void>((resolve) => (release = resolve)) });
    return () => release();
  };

  it("a wall-clock jump forward an hour doesn't cut a wait short", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const id = await client.createTask(task());
    let jump = 0;
    await withClockJump(() => jump, async () => {
      const release = holdNextPoll(api);
      let outcome: "pending" | "resolved" | "rejected" = "pending";
      const waiting = client.wait(id, { timeoutMs: 30_000 });
      waiting.then(() => (outcome = "resolved"), () => (outcome = "rejected"));
      await until(() => api.requests("completed").length === 1, 5000, "the first poll");
      jump = 3_600_000; // NTP step, a VM resuming, a user changing the time: it happens while the poll is in flight
      release();
      // The loop carries on past the jump. A deadline measured on the wall clock would have fired by now.
      await until(() => api.requests("completed").length >= 3 || outcome !== "pending", 5000, "the loop to keep polling");
      assert.equal(outcome, "pending", "the wait ended when the clock jumped");
      api.finish(id, ok("still waiting"));
      assert.equal((await waiting).results?.code, "still waiting");
    });
  });

  it("a wall-clock jump back an hour doesn't stretch a wait", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const id = await client.createTask(task());
    let jump = 0;
    await withClockJump(() => jump, async () => {
      const started = performance.now();
      const waiting = client.wait(id, { timeoutMs: 400 }).then(() => "resolved" as const, (error: unknown) => error);
      await until(() => api.requests("completed").length >= 1, 5000, "the first poll");
      jump = -3_600_000;
      // On a wall clock that went back an hour the deadline would be an hour away: the race below ends it at 10 s.
      const outcome = await Promise.race([waiting, sleep(10_000).then(() => "never ended" as const)]);
      assert.ok(outcome instanceof TaskTimeoutError, `the wait ${String(outcome)}: its deadline moved with the clock`);
      assert.ok(performance.now() - started >= 400 - TOLERANCE, "the wait ended before its deadline");
    });
  });

  it("a deadline given as a wall-clock time is converted once, then only the monotonic clock counts", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const id = await client.createTask(task());
    let jump = 0;
    await withClockJump(() => jump, async () => {
      const started = performance.now();
      const waiting = client.wait(id, { deadline: new Date(Date.now() + 500) }).then(() => "resolved" as const, (error: unknown) => error);
      await until(() => api.requests("completed").length >= 1, 5000, "the first poll");
      jump = 3_600_000; // a wall-clock deadline would be long past now
      const outcome = await Promise.race([waiting, sleep(10_000).then(() => "never ended" as const)]);
      assert.ok(outcome instanceof TaskTimeoutError, String(outcome));
      assert.ok(performance.now() - started >= 500 - TOLERANCE - 20, "the wait ended when the clock jumped, not at its deadline");
    });
  });

  it("clock jumps don't disturb the pacing of the poller", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 60 } });
    const id = await client.createTask(task());
    let jump = 0;
    await withClockJump(() => jump, async () => {
      const waiting = client.wait(id, { timeoutMs: 30_000 });
      for (const offset of [3_600_000, -7_200_000, 0]) {
        const seen = api.requests("completed").length;
        await until(() => api.requests("completed").length >= seen + 2, 5000, "two more polls");
        jump = offset; // the loop must neither stall nor speed up across the jump
      }
      const seen = api.requests("completed").length;
      await until(() => api.requests("completed").length >= seen + 2, 5000, "polls after the last jump");
      api.finish(id, ok("done"));
      assert.equal((await waiting).results?.code, "done");
    });
    for (const gap of gaps(api.times("completed"))) assert.ok(gap >= 60 - TOLERANCE, `polled after ${gap}`);
  });

  it("a known task whose deadline has passed fails at once, whatever the wall clock says", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { deadlineGraceMs: 0 } });
    const id = await client.createTask(task({ timeout: 1, group: "mine" }));
    await sleep(1100);
    const before = api.seen.length;
    // Even with the wall clock set back, the monotonic deadline has passed.
    await withClockJump(() => -86_400_000, async () => {
      await assert.rejects(client.wait(id), (error: unknown) => error instanceof TaskTimeoutError && error.group === "mine");
    });
    assert.equal(api.seen.length, before);
  });
});

// A deadline caps a create (a POST, which may be abandoned) and its retries. It never caps a GET /completed: see inflight.test.ts.
describe("a deadline caps a create", () => {
  it("run()'s deadline caps the POST and the wait together", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 5000 });
    api.fail("create", { kind: "delay", ms: 150 });
    const started = performance.now();
    await assert.rejects(client.run(task(), { timeoutMs: 1000 }), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.equal(error.reason, "deadline");
      assert.ok(error.taskId !== undefined, "the task was created, so the error names it");
      return true;
    });
    const took = performance.now() - started;
    assert.ok(took >= 1000 - TOLERANCE && took < 3000, `took ${took}`);
  });
});

describe("every HTTP request has a timeout", () => {
  it("a poll that gets no answer is abandoned after requestTimeoutMs and the loop tries again", async (t) => {
    const { api, client: setup, make } = await harness(t);
    const client = make({ requestTimeoutMs: 120 });
    const id = await setup.createTask(task()); // not with the 120 ms client: creating must not race its timeout
    api.fail("completed", { kind: "hang" });
    api.finish(id, ok("second try"));
    const started = performance.now();
    assert.equal((await client.wait(id, { timeoutMs: 4000 })).results?.code, "second try");
    assert.ok(performance.now() - started >= 120 - TOLERANCE);
    assert.ok(api.requests("completed")[0]!.closedAt !== null, "the abandoned request was closed");
  });

  it("a direct poll() takes the per-call timeout, and the client's by default", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 5000 });
    api.fail("completed", { kind: "hang" }, { kind: "hang" });
    const started = performance.now();
    await assert.rejects(client.poll("g", { timeoutMs: 100 }), (error: unknown) => error instanceof NetworkError && error.timedOut);
    assert.ok(performance.now() - started < 1500);
    const quick = make({ requestTimeoutMs: 100 });
    await assert.rejects(quick.poll("g"), (error: unknown) => error instanceof NetworkError && error.timedOut);
  });

  it("the client's timeout applies to create, verify and poll alike", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 90, timing: { maxCreateAttempts: 1 } });
    api.fail("create", { kind: "hang" });
    api.fail("verify", { kind: "hang" });
    api.fail("completed", { kind: "hang" });
    for (const call of [() => client.createTask(task()), () => client.verify(), () => client.poll()]) {
      const started = performance.now();
      await assert.rejects(call(), (error: unknown) => error instanceof NetworkError && error.timedOut);
      assert.ok(performance.now() - started < 1500);
    }
    void FAST;
  });
});
