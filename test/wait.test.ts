import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  codeTask,
  InvalidRequestError,
  MailmanError,
  TaskFailedError,
  TaskTimeoutError,
} from "../src/index.js";
import { autoFinish, FAST, gaps, harness, sleep, task, TOLERANCE, until } from "./support/harness.js";

const ok = (code: string) => ({ status: "success" as const, results: { code } });

describe("run", { concurrency: true }, () => {
  it("creates the task, waits for it and returns the successful result", async (t) => {
    const { api, client } = await harness(t);
    autoFinish(api, { code: "482913" });
    const result = await client.run(codeTask({ email: "alias@example.com", from: "noreply@example.com", subjectIncludes: "code" }));
    assert.deepEqual(result, { id: api.created[0]!.id, status: "success", results: { code: "482913" } });
    await until(() => client.stats().pollers === 0, 2000, "the loop to stop");
  });

  it("throws TaskFailedError for an error result, with its errorStatus and errorMessage", async (t) => {
    const { api, client } = await harness(t);
    api.onCreate = () => ({
      afterMs: 5,
      result: { status: "error", results: { errorStatus: "invalid mail task", errorMessage: "mailElements[0].regex: parse error" } },
    });
    await assert.rejects(client.run(task()), (error: unknown) => {
      assert.ok(error instanceof TaskFailedError);
      assert.equal(error.taskId, api.created[0]!.id);
      assert.equal(error.errorStatus, "invalid mail task");
      assert.equal(error.errorMessage, "mailElements[0].regex: parse error");
      return true;
    });
  });

  it("throws TaskTimeoutError for a timeout result", async (t) => {
    const { api, client } = await harness(t);
    api.onCreate = () => ({ afterMs: 5, result: { status: "timeout" } });
    await assert.rejects(client.run(task()), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.equal(error.reason, "timeout");
      assert.equal(error.taskId, api.created[0]!.id);
      return true;
    });
  });

  it("throws TaskTimeoutError when the deadline passes without a result", async (t) => {
    const { api, client } = await harness(t);
    await assert.rejects(client.run(task(), { timeoutMs: 700 }), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.equal(error.reason, "deadline");
      assert.equal(error.taskId, api.created[0]!.id);
      assert.match(error.message, /lost.*Create it again/);
      return true;
    });
  });

  it("creates and polls the task's own group, not the client's", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ group: "client-group" });
    autoFinish(api);
    await client.run(task({ group: "x" }));
    assert.equal(api.created[0]!.task.group, "x");
    const polls = api.requests("completed");
    assert.ok(polls.length >= 1);
    for (const seen of polls) assert.equal(seen.group, "x", "polled a group the task isn't in");
  });

  it("uses the client's group for both when the task names none, even if it says `group: undefined`", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ group: "client-group" });
    autoFinish(api);
    await client.run(task({ group: undefined }));
    assert.equal(api.created[0]!.task.group, "client-group");
    for (const seen of api.requests("completed")) assert.equal(seen.group, "client-group");
  });

  it("an explicit empty group is a group: created without one, polled without the parameter", async (t) => {
    const { api, client } = await harness(t);
    autoFinish(api);
    await client.run(task({ group: "" }));
    assert.equal(api.created[0]!.task.group, "");
    for (const seen of api.requests("completed")) assert.equal(seen.group, null);
  });

  it("many concurrent runs share one polling loop", async (t) => {
    const { api, client } = await harness(t);
    autoFinish(api, (sent) => ({ code: `code-for-${sent.email}` }), 30);
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, client.stats().pollers)), 2);
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => client.run(task({ email: `user${i}@example.com` }), { timeoutMs: 8000 })));
    clearInterval(sampler);
    for (const [i, result] of results.entries()) assert.equal(result.results.code, `code-for-user${i}@example.com`);
    assert.equal(peak, 1, "one loop, however many waits");
    const times = api.times("completed");
    assert.ok(times.length <= 10, `${times.length} polls for 40 runs`);
    for (const gap of gaps(times)) assert.ok(gap >= FAST.pollIntervalMs! - TOLERANCE);
    await until(() => client.stats().pollers === 0);
    assert.deepEqual(client.stats().waiters, 0);
  });
});

describe("wait", { concurrency: true }, () => {
  it("returns error and timeout results without throwing; run() is what turns them into errors", async (t) => {
    const { api, client } = await harness(t);
    const [a, b] = [await client.createTask(task()), await client.createTask(task())];
    const waits = Promise.all([client.wait(a), client.wait(b)]);
    api.finish(a, { status: "error", results: { errorStatus: "invalid mail task", errorMessage: "x" } });
    api.finish(b, { status: "timeout" });
    const [error, timeout] = await waits;
    assert.equal(error.status, "error");
    assert.equal(error.results?.errorStatus, "invalid mail task");
    assert.deepEqual(timeout, { id: b, status: "timeout" });
  });

  it("returns a result that arrived before wait() was called", async (t) => {
    const { api, client } = await harness(t);
    const a = await client.createTask(task());
    const b = await client.createTask(task());
    const waitA = client.wait(a); // this starts the loop
    api.finish(b, ok("B"));
    api.finish(a, ok("A"));
    assert.equal((await waitA).results?.code, "A");
    // B came in the same page, with nobody waiting for it yet.
    assert.equal(client.stats().bufferedResults, 1);
    const polls = api.requests("completed").length;
    assert.equal((await client.wait(b)).results?.code, "B");
    assert.equal(api.requests("completed").length, polls, "wait() polled again instead of using the buffer");
    assert.equal(client.stats().bufferedResults, 0, "both were handed out");
    assert.equal(client.stats().retainedResults, 2, "and both stay readable");
  });

  it("two concurrent waits on one group share one loop and each gets its own result, whatever the order", async (t) => {
    const { api, client } = await harness(t);
    const a = await client.createTask(task());
    const b = await client.createTask(task());
    const waitA = client.wait(a);
    const waitB = client.wait(b);
    await until(() => api.requests("completed").length >= 1);
    assert.equal(client.stats().pollers, 1);
    assert.equal(client.stats().waiters, 2);
    api.finish(b, ok("for-b"));
    assert.equal((await waitB).results?.code, "for-b");
    assert.equal(client.stats().waiters, 1, "A is still waiting");
    api.finish(a, ok("for-a"));
    assert.equal((await waitA).results?.code, "for-a");
    for (const gap of gaps(api.times("completed"))) assert.ok(gap >= FAST.pollIntervalMs! - TOLERANCE, "one loop's pace");
  });

  it("several waits on the same id all get the result", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    const waits = [client.wait(id), client.wait(id), client.wait(id)];
    await until(() => client.stats().waiters === 3);
    api.finish(id, ok("shared"));
    for (const result of await Promise.all(waits)) assert.equal(result.results?.code, "shared");
  });

  it("throws TaskTimeoutError at the deadline, and the loop stops with the last waiter", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task({ group: "g" }));
    const started = performance.now();
    await assert.rejects(client.wait(id, { timeoutMs: 150 }), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.deepEqual([error.taskId, error.group, error.reason], [id, "g", "deadline"]);
      return true;
    });
    const took = performance.now() - started;
    assert.ok(took >= 150 - TOLERANCE && took < 1500, `took ${took}`);
    await until(() => client.stats().pollers === 0, 2000, "the loop to stop");
    const polls = api.requests("completed").length;
    await sleep(4 * FAST.pollIntervalMs!);
    assert.equal(api.requests("completed").length, polls, "polling went on after the last wait left");
  });

  it("without options the deadline is the task's timeout plus the grace, counted from creation", async (t) => {
    const { client, make } = await harness(t);
    const slow = make({ timing: { deadlineGraceMs: 150 } });
    const id = await slow.createTask(task({ timeout: 1 }));
    const created = performance.now();
    await assert.rejects(slow.wait(id), TaskTimeoutError);
    const took = performance.now() - created;
    assert.ok(took >= 1150 - TOLERANCE, `gave up after ${took} ms, before 1 s + 150 ms`);
    assert.ok(took < 2500);
    void client;
  });

  it("a known task whose deadline has passed fails at once, keeps its own group, and polls nothing", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ group: "default-group", timing: { deadlineGraceMs: 0 } });
    const id = await client.createTask(task({ group: "keep-me", timeout: 1 }));
    await sleep(1100);
    const before = api.seen.length;
    const started = performance.now();
    await assert.rejects(client.wait(id), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.deepEqual([error.taskId, error.group, error.reason], [id, "keep-me", "deadline"]);
      return true;
    });
    assert.ok(performance.now() - started < 500, "should not wait at all");
    assert.equal(api.seen.length, before, "no request, in particular none for the default group");
    assert.equal(client.stats().pollers, 0);
  });

  it("a result that shows up for an expired task is still handed over: results are never dropped", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { deadlineGraceMs: 0 } });
    const late = await client.createTask(task({ timeout: 1 }));
    const other = await client.createTask(task({ timeout: 30 }));
    const waiting = client.wait(other, { timeoutMs: 3000 }); // keeps the loop polling
    await sleep(1150);
    api.finish(late, ok("late but real"));
    await until(() => client.stats().bufferedResults === 1, 2000, "the late result to be polled");
    // The deadline of `late` passed long ago, yet its result is there.
    assert.equal((await client.wait(late)).results?.code, "late but real");
    api.finish(other, ok("x"));
    await waiting;
  });

  it("a task id this client doesn't know needs an explicit deadline; there is no fallback to the default group", async (t) => {
    const { api, client, make } = await harness(t);
    await assert.rejects(client.wait("f".repeat(32)), (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.match(error.message, /timeoutMs or deadline/);
      return true;
    });
    assert.equal(api.seen.length, 0);

    // With a deadline (and the group it lives in) it works, for example for a task another process created.
    const other = make();
    const id = await other.createTask(task({ group: "elsewhere" }));
    api.finish(id, ok("found"));
    const result = await client.wait(id, { group: "elsewhere", timeoutMs: 2000 });
    assert.equal(result.results?.code, "found");
    assert.ok(api.requests("completed").every((seen) => seen.group === "elsewhere"));
  });

  it("an unknown id with only a deadline polls the client's group", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ group: "mine" });
    await assert.rejects(client.wait("a".repeat(32), { timeoutMs: 100 }), TaskTimeoutError);
    assert.ok(api.requests("completed").every((seen) => seen.group === "mine"));
  });

  it("a known task's group can't be overridden", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task({ group: "x" }));
    await assert.rejects(client.wait(id, { group: "y" }), (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.match(error.message, /created in group "x", not "y"/);
      return true;
    });
    // Saying the right group is fine.
    api.finish(id, ok("1"));
    assert.equal((await client.wait(id, { group: "x" })).status, "success");
  });

  it("accepts the deadline as a Date or epoch milliseconds, and the earlier of deadline and timeoutMs wins", async (t) => {
    const { client } = await harness(t);
    // Built per case: a deadline is a point in time, so it must be computed when the case starts.
    const cases: Array<() => { deadline?: Date | number; timeoutMs?: number }> = [
      () => ({ deadline: new Date(Date.now() + 150) }),
      () => ({ deadline: Date.now() + 150 }),
      () => ({ deadline: Date.now() + 60_000, timeoutMs: 150 }),
      () => ({ deadline: Date.now() + 150, timeoutMs: 60_000 }),
    ];
    for (const [i, make] of cases.entries()) {
      const id = await client.createTask(task());
      const options = make();
      const started = performance.now();
      await assert.rejects(client.wait(id, options), TaskTimeoutError);
      const took = performance.now() - started;
      assert.ok(took >= 150 - TOLERANCE - 20 && took < 1500, `case ${i} took ${took}`);
    }
  });

  it("rejects options it can't use", async (t) => {
    const { client } = await harness(t);
    const id = await client.createTask(task());
    for (const options of [{ timeoutMs: -1 }, { timeoutMs: Number.NaN }, { timeoutMs: Infinity }, { deadline: Number.NaN }, { deadline: new Date("nope") }]) {
      await assert.rejects(client.wait(id, options as never), InvalidRequestError);
    }
    await assert.rejects(client.wait("", {}), InvalidRequestError);
  });
});

describe("wait: cancellation and failures", { concurrency: true }, () => {
  it("an AbortSignal ends the wait; the task stays and can be waited for again", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    const controller = new AbortController();
    const waiting = client.wait(id, { signal: controller.signal });
    await until(() => client.stats().waiters === 1);
    controller.abort(new Error("enough"));
    await assert.rejects(waiting, /enough/);
    assert.equal(client.stats().waiters, 0);
    await until(() => client.stats().pollers === 0, 2000, "the loop to stop");
    assert.equal(client.stats().trackedTasks, 1);
    api.finish(id, ok("later"));
    assert.equal((await client.wait(id)).results?.code, "later");
  });

  it("an already aborted signal waits for nothing", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.wait(id, { signal: controller.signal }), (error: unknown) => (error as Error).name === "AbortError");
    assert.equal(api.requests("completed").length, 0);
  });

  it("a fatal answer (a 400 on /completed) fails the waits of the group and frees the loop for the next wait", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.fail("completed", { kind: "status", status: 400, body: { error: "invalid group query" } });
    await assert.rejects(client.wait(id, { timeoutMs: 3000 }), InvalidRequestError);
    assert.equal(client.stats().waiters, 0);
    await until(() => client.stats().pollers === 0);
    api.finish(id, ok("recovered"));
    assert.equal((await client.wait(id, { timeoutMs: 3000 })).results?.code, "recovered");
  });

  it("a 404 is fatal too, but a 500 or 502 is ridden out", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.fail("completed", { kind: "status", status: 404 });
    await assert.rejects(client.wait(id, { timeoutMs: 3000 }), (error: unknown) => error instanceof MailmanError && error.status === 404);
    api.fail("completed", { kind: "status", status: 502, body: "<html>bad gateway</html>" }, { kind: "status", status: 500, body: { error: "random generator failed" } });
    api.finish(id, ok("after the 5xx"));
    assert.equal((await client.wait(id, { timeoutMs: 3000 })).results?.code, "after the 5xx");
  });

  it("close() rejects waits in progress and refuses new work", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    const waiting = client.wait(id);
    await until(() => client.stats().waiters === 1);
    client.close();
    await assert.rejects(waiting, /closed/);
    await assert.rejects(client.createTask(task()), /closed/);
    await assert.rejects(client.wait(id), /closed/);
    await assert.rejects(client.poll(), /closed/);
    await assert.rejects(client.verify(), /closed/);
    client.close(); // twice is fine
    const polls = api.requests("completed").length;
    await sleep(150);
    assert.equal(api.requests("completed").length, polls, "polling stopped");
  });
});
