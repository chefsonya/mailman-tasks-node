import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskTimeoutError, AuthError } from "../src/index.js";
import { gaps, harness, task, TOLERANCE, until } from "./support/harness.js";

const ok = (code: string) => ({ status: "success" as const, results: { code } });
const pad = (n: number) => n.toString(16).padStart(32, "0");

/** Every consecutive pair of requests on /completed is at least `min` ms apart. */
function assertMinimumGap(times: number[], min: number, what: string): void {
  for (const [i, gap] of gaps(times).entries()) assert.ok(gap >= min - TOLERANCE, `${what}: requests ${i + 1} and ${i + 2} were ${gap.toFixed(1)} ms apart, minimum ${min}`);
}

describe("pace of the polling loop", { concurrency: true }, () => {
  it("polls every interval while a wait is open, and no faster", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 60 } });
    const id = await client.createTask(task());
    const waiting = client.wait(id, { timeoutMs: 450 });
    await assert.rejects(waiting, TaskTimeoutError);
    const times = api.times("completed");
    assert.ok(times.length >= 2 && times.length <= 9, `${times.length} polls in 450 ms at a 60 ms interval`);
    assertMinimumGap(times, 60, "steady polling");
  });

  it("a 429 with Retry-After: 1 never brings a re-poll after 1 second when the interval is longer", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 1500 } });
    const id = await client.createTask(task());
    api.fail("completed", { kind: "status", status: 429, headers: { "Retry-After": "1" }, body: { error: "rate limit exceeded" } });
    api.finish(id, ok("1"));
    const result = await client.wait(id, { timeoutMs: 6000 });
    assert.equal(result.status, "success");
    const [gap] = gaps(api.times("completed"));
    assert.ok(gap! >= 1500 - TOLERANCE, `re-polled ${gap!.toFixed(0)} ms after a 429 Retry-After: 1 (interval 1500)`);
  });

  it("a Retry-After longer than the interval is waited out in full", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.fail("completed", { kind: "status", status: 429, headers: { "Retry-After": "1" }, body: { error: "rate limit exceeded" } });
    api.finish(id, ok("1"));
    await client.wait(id, { timeoutMs: 6000 });
    const [gap] = gaps(api.times("completed"));
    assert.ok(gap! >= 1000 - TOLERANCE, `re-polled after ${gap!.toFixed(0)} ms`);
  });

  it("follows a full page of 100 sooner, and routes all 250 results by id", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 400, fullPageIntervalMs: 20 } });
    const ids: string[] = [];
    for (let i = 0; i < 250; i++) ids.push(await client.createTask(task({ email: `a${i}@example.com` })));
    const waits = ids.map((id) => client.wait(id, { timeoutMs: 4000 }));
    await until(() => api.requests("completed").length >= 1);
    for (const [i, id] of ids.entries()) api.finish(id, ok(String(i)));
    const results = await Promise.all(waits);
    for (const [i, result] of results.entries()) {
      assert.equal(result.id, ids[i]);
      assert.equal(result.results?.code, String(i));
    }
    // The results came in pages of 100, 100 and 50, the first two a full-page gap apart.
    const times = api.times("completed");
    assert.ok(times.length <= 6, `${times.length} polls`);
    assertMinimumGap(times, 20, "after full pages");
    assert.equal(api.waiting(""), 0);
    void pad;
  });

  it("a 401 slows the loop to the unauthorized delay and it keeps going until Mailman is back (M11)", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.connected = false;
    const waiting = client.wait(id, { timeoutMs: 5000 });
    await until(() => api.requests("completed").length >= 4, 4000, "four 401s");
    assertMinimumGap(api.times("completed"), 70, "while unauthorized");
    // Mailman reconnects, the task completes: the same wait resolves.
    api.connected = true;
    api.finish(id, ok("654321"));
    assert.equal((await waiting).results?.code, "654321");
  });

  it("a wait that never gets a key that works times out, and says why", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.connected = false;
    await assert.rejects(client.wait(id, { timeoutMs: 400 }), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.ok(error.cause instanceof AuthError, "the last poll error rides along");
      assert.equal(error.reason, "deadline");
      return true;
    });
    assert.ok(api.requests("completed").length >= 3, "it kept polling instead of giving up on the 401s");
  });

  it("backs off after failures: 1, 2, 4 ... with jitter that only adds, never below the interval", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 10, backoffBaseMs: 40, backoffMaxMs: 160 } });
    const id = await client.createTask(task());
    const failure = { kind: "drop" } as const;
    api.fail("completed", failure, failure, failure, { kind: "status", status: 503 }, { kind: "status", status: 500 });
    api.finish(id, ok("1"));
    await client.wait(id, { timeoutMs: 5000 });
    const observed = gaps(api.times("completed"));
    const steps = [40, 80, 160, 160, 160];
    for (const [i, step] of steps.entries()) {
      assert.ok(observed[i]! >= step - TOLERANCE, `gap ${i + 1}: ${observed[i]!.toFixed(0)} < ${step}`);
      assert.ok(observed[i]! <= step * 1.25 + 500, `gap ${i + 1}: ${observed[i]!.toFixed(0)} far above ${step * 1.25}`);
    }
  });

  it("keeps the minimum gap between ANY two attempts, retries included, across every kind of failure", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 60, backoffBaseMs: 10, backoffMaxMs: 20 } });
    const id = await client.createTask(task());
    api.fail(
      "completed",
      { kind: "status", status: 503 },
      { kind: "drop" },
      { kind: "truncate", status: 500 },
      { kind: "status", status: 408 },
      { kind: "status", status: 200, body: "garbage" },
      { kind: "status", status: 401, body: { error: "invalid user API key" } },
      { kind: "status", status: 429, body: { error: "rate limit exceeded" } },
    );
    api.finish(id, ok("1"));
    await client.wait(id, { timeoutMs: 8000 });
    assert.equal(api.requests("completed").length, 8);
    assertMinimumGap(api.times("completed"), 60, "mixed failures");
  });

  it("a direct poll() shares the gate with the loop: no two attempts are closer than the interval", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 60 } });
    const id = await client.createTask(task());
    const waiting = client.wait(id, { timeoutMs: 1500 });
    await until(() => api.requests("completed").length >= 1);
    // Hammer poll() while the loop runs.
    const direct = Promise.all([client.poll(), client.poll(), client.poll(), client.poll()]);
    await direct;
    api.finish(id, ok("1"));
    await waiting;
    assert.ok(api.requests("completed").length >= 5);
    assertMinimumGap(api.times("completed"), 60, "loop and direct polls");
  });

  it("a reset connection is a failed attempt like any other: one request, and the next one is still paced", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 80, backoffBaseMs: 5, backoffMaxMs: 10 } });
    const id = await client.createTask(task());
    api.fail("completed", { kind: "drop" });
    api.finish(id, ok("1"));
    await client.wait(id, { timeoutMs: 3000 });
    const polls = api.requests("completed");
    assert.equal(polls.length, 2, "one failed attempt and one retry: nothing added a request of its own");
    assertMinimumGap(polls.map((p) => p.at), 80, "after the reset");
  });

  it("different groups are paced separately", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 300 } });
    const a = await client.createTask(task({ group: "a" }));
    const b = await client.createTask(task({ group: "b" }));
    const waits = [client.wait(a, { timeoutMs: 150 }), client.wait(b, { timeoutMs: 150 })];
    await Promise.allSettled(waits);
    const firstOfEach = (group: string) => api.requests("completed").find((s) => s.group === group)!;
    assert.ok(firstOfEach("a") && firstOfEach("b"), "both groups were polled at once, neither waited for the other's interval");
    assert.ok(Math.abs(firstOfEach("a").at - firstOfEach("b").at) < 250, "one group waited for the other's interval");
  });
});
