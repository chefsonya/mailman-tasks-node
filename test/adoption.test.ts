import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TooManyTasksError } from "../src/index.js";
import { harness, sleep, task, until } from "./support/harness.js";
import type { MockApi } from "./support/mock-api.js";

const ok = (code: string) => ({ status: "success" as const, results: { code } });
// Ids of other people's tasks. The mock numbers its own tasks from 1, so these stay clear of them.
const foreignId = (n: number) => (0x1000 + n).toString(16).padStart(32, "0");

/**
 * The next create is accepted at once and its task finishes at once, but the client is kept waiting for the answer:
 * the task exists, and can be collected, while the client doesn't know its id yet.
 */
function lateAnswer(api: MockApi): { release: () => void } {
  let release: () => void = () => undefined;
  api.onCreate = () => ({ afterMs: 0, result: ok("fast") });
  api.fail("create", { kind: "hold-response", release: new Promise<void>((resolve) => (release = resolve)) });
  return { release: () => release() };
}

// A shared poll (the loop of somebody else's wait, or a direct poll()) can collect a fast task's result before the
// answer to its create has been read. The result is then filed as somebody else's. When the create is registered, the
// result must become the task's own: counted, protected and expiring with its task.
describe("a result that arrives before its create answer belongs to its task", { concurrency: true }, () => {
  it("reading it frees the slot: the next create isn't refused", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 1 } });
    // Somebody else's wait keeps the loop polling the group, so the loop is what finds the fast task's result.
    client.wait(foreignId(99), { timeoutMs: 20_000 }).catch(() => undefined);
    const late = lateAnswer(api);
    const creating = client.createTask(task());
    await until(() => client.stats().bufferedResults === 1, 5000, "the loop to collect the result of a task it hasn't heard of");
    late.release();
    const id = await creating;
    assert.equal((await client.wait(id)).results?.code, "fast");
    // The result is the task's own and has been handed out: the only slot is free again.
    await client.createTask(task());
  });

  it("the task's metadata goes with its result when that expires", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { resultTtlMs: 400 } });
    client.wait(foreignId(99), { timeoutMs: 20_000 }).catch(() => undefined);
    const late = lateAnswer(api);
    const creating = client.createTask(task());
    await until(() => client.stats().bufferedResults === 1, 5000, "the loop to collect the result");
    late.release();
    const id = await creating;
    assert.equal((await client.wait(id)).results?.code, "fast");
    assert.equal(client.stats().trackedTasks, 1);
    await sleep(550); // past the TTL
    const stats = client.stats();
    assert.deepEqual([stats.trackedTasks, stats.retainedResults, stats.bufferedResults], [0, 0, 0], "the task's entry was left behind");
  });

  it("a result already handed out by a direct poll() is the task's too", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 1 } });
    const late = lateAnswer(api);
    const creating = client.createTask(task());
    await until(() => api.waiting("default") === 1, 5000, "the task to finish at the server");
    assert.equal((await client.poll()).length, 1); // the caller has it; the client doesn't know the task yet
    late.release();
    const id = await creating;
    assert.equal((await client.wait(id)).results?.code, "fast", "still readable by id");
    await client.createTask(task()); // it was handed out, so it no longer holds the slot
  });

  it("it is protected like any other: the bound on unclaimed results doesn't take it", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxUnclaimedResults: 1 } });
    client.wait(foreignId(99), { timeoutMs: 20_000 }).catch(() => undefined);
    const late = lateAnswer(api);
    const creating = client.createTask(task());
    await until(() => client.stats().bufferedResults === 1, 5000, "the loop to collect the result");
    late.release();
    const id = await creating;
    // One result of somebody else's task arrives. The one place for unclaimed results is free: the adopted result is the
    // task's own and no longer counts as unclaimed, so this one is kept next to it.
    api.push("default", { id: foreignId(1), status: "success", results: { code: "f1" } });
    await until(() => client.stats().bufferedResults === 2, 5000, "the loop to keep one unclaimed result next to the adopted one");
    // A second arrives. Only one unclaimed result is kept, and it must not be ours.
    const second = client.wait(foreignId(2), { timeoutMs: 5000 });
    api.push("default", { id: foreignId(2), status: "success", results: { code: "f2" } });
    assert.equal((await second).results?.code, "f2");
    assert.equal((await client.wait(id, { timeoutMs: 2000 })).results?.code, "fast");
  });

  it("its task isn't reclaimed when the deadline passes while the result waits", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 1 }, timing: { deadlineGraceMs: 0 } });
    client.wait(foreignId(99), { timeoutMs: 20_000 }).catch(() => undefined);
    const late = lateAnswer(api);
    const creating = client.createTask(task({ timeout: 1 }));
    await until(() => client.stats().bufferedResults === 1, 5000, "the loop to collect the result");
    late.release();
    const id = await creating;
    await sleep(1100); // the deadline has passed and nobody has taken the result
    // The result is still there, so the task is live: reclaiming slots must not take it from under the result.
    await assert.rejects(client.createTask(task()), TooManyTasksError);
    assert.equal((await client.wait(id)).results?.code, "fast");
  });
});
