import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MailmanError, TaskTimeoutError, TooManyTasksError } from "../src/index.js";
import { autoFinish, FAST, gaps, harness, sleep, task, TOLERANCE, until } from "./support/harness.js";

const ok = (code: string) => ({ status: "success" as const, results: { code } });
const pad = (n: number) => n.toString(16).padStart(32, "0");
const idle = { trackedTasks: 0, groups: 0, pollers: 0, waiters: 0, bufferedResults: 0, retainedResults: 0 };

describe("a polling loop that dies never stays registered", { concurrency: true }, () => {
  it("survives a truncated error body: the read fails after the status arrived, and the loop carries on", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    // Each answer starts (status and headers arrive) and then the connection dies mid-body: reading the body throws.
    api.fail("completed", { kind: "truncate", status: 500 }, { kind: "truncate", status: 503 }, { kind: "truncate", status: 200 });
    api.finish(id, ok("after the truncations"));
    assert.equal((await client.wait(id, { timeoutMs: 4000 })).results?.code, "after the truncations");
    assert.equal(api.requests("completed").length, 4, "three failed attempts, then the one that worked");
    await until(() => client.stats().pollers === 0);
    assert.equal(client.stats().waiters, 0);
  });

  it("survives a body that stalls: the request timeout covers the body too", async (t) => {
    const { api, client: setup, make } = await harness(t);
    const client = make({ requestTimeoutMs: 100 });
    const id = await setup.createTask(task()); // not with the 100 ms client: creating must not race its timeout
    api.fail("completed", { kind: "stall" }); // headers and part of the body arrive, then nothing, and the server never closes
    api.finish(id, ok("after the stall"));
    const waiting = client.wait(id, { timeoutMs: 8000 });
    // 1. The stalled request is abandoned: the client closes the socket itself, because the server never will.
    await until(() => api.requests("completed")[0]?.closedAt != null, 5000, "the client to close the stalled connection");
    // 2. And the loop carries on: it asks again, and that answer is delivered.
    assert.equal((await waiting).results?.code, "after the stall");
    assert.ok(api.requests("completed").length >= 2, "the loop didn't try again");
  });

  it("when the loop crashes outright its slot is cleared, its waiters are failed, and the next wait starts a fresh loop", async (t) => {
    const { api, make } = await harness(t);
    let draws = 0;
    // The jitter source is called while the gate works out the backoff after a failed poll: outside any
    // network error handling, which is where a bug would hide.
    const client = make({
      timing: {
        random: () => {
          if (draws++ === 0) throw new Error("jitter source broke");
          return 0;
        },
      },
    });
    const id = await client.createTask(task());
    api.fail("completed", { kind: "status", status: 503 });

    await assert.rejects(client.wait(id, { timeoutMs: 3000 }), (error: unknown) => {
      assert.ok(error instanceof MailmanError);
      assert.match(error.message, /polling loop stopped unexpectedly: jitter source broke/);
      assert.equal((error.cause as Error).message, "jitter source broke");
      return true;
    });
    assert.equal(client.stats().pollers, 0, "the dead loop is still registered");
    assert.equal(client.stats().waiters, 0);

    // A fresh loop takes over, and its first request still honours the gate: no hot restart.
    api.finish(id, ok("fresh loop"));
    assert.equal((await client.wait(id, { timeoutMs: 3000 })).results?.code, "fresh loop");
    const [first, second] = api.times("completed");
    assert.ok(second! - first! >= FAST.pollIntervalMs! - TOLERANCE, `restarted after ${second! - first!} ms`);
  });

  it("a waiter that arrives while the loop is winding down is not stranded", async (t) => {
    const { api, client } = await harness(t);
    const a = await client.createTask(task());
    const b = await client.createTask(task());
    const waitA = client.wait(a);
    api.finish(a, ok("A"));
    await waitA;
    // The loop has just lost its last waiter and may not have noticed yet.
    const waitB = client.wait(b, { timeoutMs: 3000 });
    api.finish(b, ok("B"));
    assert.equal((await waitB).results?.code, "B");
    // And again, in the same tick.
    const c = await client.createTask(task());
    const d = await client.createTask(task());
    const waitC = client.wait(c, { timeoutMs: 3000 });
    api.finish(c, ok("C"));
    api.finish(d, ok("D"));
    await waitC;
    assert.equal((await client.wait(d, { timeoutMs: 3000 })).results?.code, "D");
  });

  it("a fatal answer ends the loop, rejects the waits, and leaves nothing registered", async (t) => {
    const { api, client } = await harness(t);
    const [a, b] = [await client.createTask(task()), await client.createTask(task())];
    api.fail("completed", { kind: "status", status: 405 });
    const waits = await Promise.allSettled([client.wait(a, { timeoutMs: 3000 }), client.wait(b, { timeoutMs: 3000 })]);
    assert.deepEqual(waits.map((w) => w.status), ["rejected", "rejected"]);
    await until(() => client.stats().pollers === 0);
    assert.equal(client.stats().waiters, 0);
  });
});

describe("results are never dropped", { concurrency: true }, () => {
  it("a wait that fails later doesn't lose results the loop already received for other tasks", async (t) => {
    const { api, client } = await harness(t);
    const slow = await client.createTask(task());
    const fast = await client.createTask(task());
    const waiting = client.wait(slow, { timeoutMs: 400 });
    await until(() => api.requests("completed").length >= 1);
    api.finish(fast, ok("kept"));
    await assert.rejects(waiting, TaskTimeoutError);
    // `fast` was polled while `slow` waited, and nobody was waiting for it: it was buffered.
    assert.equal((await client.wait(fast)).results?.code, "kept");
  });

  it("a fatal error ending a wait doesn't lose what came before it", async (t) => {
    const { api, client } = await harness(t);
    const slow = await client.createTask(task());
    const fast = await client.createTask(task());
    const waiting = client.wait(slow, { timeoutMs: 3000 });
    await until(() => api.requests("completed").length >= 1);
    api.finish(fast, ok("kept"));
    await until(() => client.stats().bufferedResults === 1, 2000, "fast's result to be polled");
    api.fail("completed", { kind: "status", status: 400, body: { error: "invalid group query" } });
    await assert.rejects(waiting, MailmanError);
    assert.equal((await client.wait(fast)).results?.code, "kept");
  });

  it("a result that comes in while a wait is aborted is kept for the next one", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    const other = await client.createTask(task());
    const controller = new AbortController();
    const first = client.wait(id, { signal: controller.signal });
    const keepPolling = client.wait(other, { timeoutMs: 2000 });
    await until(() => api.requests("completed").length >= 1);
    controller.abort();
    await assert.rejects(first, (error: unknown) => (error as Error).name === "AbortError");
    api.finish(id, ok("still here"));
    await until(() => client.stats().bufferedResults === 1);
    assert.equal((await client.wait(id)).results?.code, "still here");
    api.finish(other, ok("x"));
    await keepPolling;
  });

  it("keeps a result for an hour (here: the configured TTL) and then lets go of it", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { resultTtlMs: 250 } });
    const a = await client.createTask(task());
    const b = await client.createTask(task());
    const busy = await client.createTask(task());
    const waiting = client.wait(a);
    // The group stays active, so the expired result must be dropped by the TTL itself, not by the group being retired.
    const keepActive = client.wait(busy, { timeoutMs: 700 });
    api.finish(b, ok("B"));
    api.finish(a, ok("A"));
    await waiting;
    assert.equal(client.stats().bufferedResults, 1);
    await sleep(350);
    // B's result is past its TTL: the next wait does not find it and has to give up.
    await assert.rejects(client.wait(b, { timeoutMs: 120 }), TaskTimeoutError);
    assert.equal(client.stats().bufferedResults, 0);
    await assert.rejects(keepActive, TaskTimeoutError);
  });
});

describe("a live task's routing metadata is never evicted", { concurrency: true }, () => {
  it("rejects a create over the limit before sending it, and every tracked task still waits on its own group", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 3 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await client.createTask(task({ group: `g${i}` })));

    await assert.rejects(client.createTask(task()), (error: unknown) => {
      assert.ok(error instanceof TooManyTasksError);
      assert.equal(error.limit, 3);
      assert.match(error.message, /3 tasks/);
      return true;
    });
    assert.equal(api.requests("create").length, 3, "the fourth create must not be sent");
    assert.equal(client.stats().trackedTasks, 3);

    // Nothing was evicted to make room: each task still knows its group and its deadline.
    for (const [i, id] of ids.entries()) api.finish(id, ok(`r${i}`));
    const results = await Promise.all(ids.map((id) => client.wait(id)));
    assert.deepEqual(results.map((r) => r.results?.code), ["r0", "r1", "r2"]);
    const polled = new Set(api.requests("completed").map((s) => s.group));
    assert.deepEqual([...polled].sort(), ["g0", "g1", "g2"]);
    // Handed out, so no longer live: room again, although the results stay readable.
    assert.equal(client.stats().retainedResults, 3);
    await client.createTask(task());
  });

  it("a task whose result is still buffered is live too", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 2 } });
    const a = await client.createTask(task());
    const b = await client.createTask(task());
    const waiting = client.wait(a);
    api.finish(b, ok("B"));
    api.finish(a, ok("A"));
    await waiting; // B is buffered now
    assert.equal(client.stats().bufferedResults, 1);
    assert.equal(client.stats().retainedResults, 1, "a was handed out: readable, but no longer live");
    await client.createTask(task()); // takes the slot a freed
    // B's deadline is far away, and its result is buffered: it must not be reclaimed to make room.
    await assert.rejects(client.createTask(task()), TooManyTasksError);
    assert.equal((await client.wait(b)).results?.code, "B");
    await client.createTask(task()); // collected: room again
  });

  it("reclaims only what is finished or expired", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 2 }, timing: { deadlineGraceMs: 0 } });
    const shortLived = await client.createTask(task({ timeout: 1 }));
    const longLived = await client.createTask(task({ timeout: 600 }));
    await assert.rejects(client.createTask(task()), TooManyTasksError, "both are still live");
    await sleep(1100); // shortLived expires
    const replacement = await client.createTask(task()); // reclaims the expired one, and only that
    assert.equal(client.stats().trackedTasks, 2);
    // The long-lived task survived the reclaim with its routing intact.
    api.finish(longLived, ok("survivor"));
    assert.equal((await client.wait(longLived)).results?.code, "survivor");
    // The expired one is gone, which is the point: an id we no longer know needs an explicit deadline.
    await assert.rejects(client.wait(shortLived), /didn't create task/);
    void replacement;
  });

  it("never reclaims a task whose result is buffered, even after its deadline has passed", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 2 }, timing: { deadlineGraceMs: 0 } });
    const early = await client.createTask(task({ timeout: 1 })); // expires after a second
    const other = await client.createTask(task({ timeout: 600 }));
    const keepPolling = client.wait(other, { timeoutMs: 4000 });
    await until(() => api.requests("completed").length >= 1);
    api.finish(early, ok("kept for later")); // polled while the task is alive, with nobody waiting for it
    await until(() => client.stats().bufferedResults === 1, 2000, "the result to be polled and buffered");
    await sleep(1100); // the deadline of `early` passes; its result is still buffered
    await assert.rejects(client.createTask(task()), TooManyTasksError, "a task with a buffered result was reclaimed to make room");
    // Its routing metadata is intact: the result is still reachable through the task's own group.
    assert.equal((await client.wait(early)).results?.code, "kept for later");
    api.finish(other, ok("x"));
    await keepPolling;
  });

  it("never reclaims a task somebody still waits for, even past the task's own deadline", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 1 }, timing: { deadlineGraceMs: 0 } });
    const id = await client.createTask(task({ timeout: 1, group: "g" }));
    const waiting = client.wait(id, { timeoutMs: 4000 }); // asked to wait longer than the task's own deadline
    await sleep(1100);
    await assert.rejects(client.createTask(task()), TooManyTasksError, "a task with a waiter was reclaimed to make room");
    api.finish(id, ok("late but wanted"));
    assert.equal((await waiting).results?.code, "late but wanted");
  });

  it("can't be overshot by creates that are in flight at the same time", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 2 } });
    api.fail("create", ...Array.from({ length: 5 }, () => ({ kind: "delay", ms: 120 }) as const));
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => client.createTask(task())));
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 2);
    const refused = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    assert.equal(refused.length, 3);
    for (const { reason } of refused) assert.ok(reason instanceof TooManyTasksError);
    assert.equal(api.requests("create").length, 2, "refused creates never reach the server");
    assert.equal(client.stats().trackedTasks, 2);
  });

  it("a failed create gives its slot back", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 1 } });
    api.fail("create", { kind: "status", status: 400, body: { error: "invalid task JSON" } }, { kind: "drop" });
    await assert.rejects(client.createTask(task()), MailmanError);
    await assert.rejects(client.createTask(task()), MailmanError);
    await client.createTask(task());
    assert.equal(client.stats().trackedTasks, 1);
  });
});

describe("per-group bookkeeping is retired once a group is idle", { concurrency: true }, () => {
  it("a client that uses one group per job doesn't grow", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxRetainedResults: 5 } });
    autoFinish(api);
    for (let i = 0; i < 15; i++) await client.run(task({ group: `job-${i}` }));
    await until(() => client.stats().groups === 0, 3000, "every group to be retired");
    // The groups are gone. What stays is the readable results, and those are bounded.
    assert.deepEqual(client.stats(), { ...idle, trackedTasks: 5, retainedResults: 5 });
  });

  it("direct polls of many groups leave nothing behind either", async (t) => {
    const { client } = await harness(t);
    for (let i = 0; i < 10; i++) await client.poll(`g${i}`);
    await until(() => client.stats().groups === 0, 3000, "every group to be retired");
    assert.deepEqual(client.stats(), idle);
  });

  it("keeps a group while its pacing still matters, so a new request can't skip the wait", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 300 } });
    await client.poll("g");
    assert.equal(client.stats().groups, 1, "retired too early: the 300 ms gap would be forgotten");
    await client.poll("g");
    assert.ok(gaps(api.times("completed"))[0]! >= 300 - TOLERANCE);
    await until(() => client.stats().groups === 0, 2000);
  });

  it("a group's bookkeeping goes when it is idle, while its results stay readable until they expire", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { resultTtlMs: 600 } });
    const a = await client.createTask(task());
    const b = await client.createTask(task());
    const waiting = client.wait(a);
    api.finish(b, ok("B"));
    api.finish(a, ok("A"));
    await waiting;
    await until(() => client.stats().groups === 0, 3000, "the group to retire");
    // The gate, the waiter map and the timers are gone; the stored results are not part of them.
    assert.equal(client.stats().bufferedResults, 1);
    assert.equal(client.stats().retainedResults, 1);
    assert.equal((await client.wait(b)).results?.code, "B", "readable without any polling");
    await sleep(700); // past the TTL
    await assert.rejects(client.wait(a), /didn't create task|forgotten/);
    assert.deepEqual(client.stats(), idle);
  });

  it("a retired group comes back with fresh pacing when it is needed again", async (t) => {
    const { make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 400 } });
    await client.poll("again");
    await until(() => client.stats().groups === 0, 3000);
    const started = performance.now();
    await client.poll("again");
    assert.ok(performance.now() - started < 250, "an idle group polls at once, without the old interval");
  });
});

describe("introspection", () => {
  it("stats() is all zeros on a new client", async (t) => {
    const { client } = await harness(t);
    assert.deepEqual(client.stats(), idle);
    void pad;
  });
});
