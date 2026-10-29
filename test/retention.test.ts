import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidRequestError, TaskTimeoutError, TooManyTasksError } from "../src/index.js";
import { autoFinish, harness, sleep, task, until } from "./support/harness.js";

const ok = (code: string) => ({ status: "success" as const, results: { code } });
const pad = (n: number) => n.toString(16).padStart(32, "0");

// M7: a result leaves the server in the response that carries it, so the client is the only copy.
// Every result is therefore stored before anyone is told, and stays readable for the retention window.
describe("a delivered result stays readable", { concurrency: true }, () => {
  it("a wait that fails in a Promise.all doesn't make its siblings' results disappear", async (t) => {
    const { api, client } = await harness(t);
    const a = await client.createTask(task());
    const b = await client.createTask(task());
    const batch = Promise.all([client.wait(a, { timeoutMs: 5000 }), client.wait(b, { timeoutMs: 300 })]);
    // wait(a) resolves as soon as its result arrives; wait(b) never gets one and times out, which rejects the whole batch.
    api.finish(a, ok("A"));
    await assert.rejects(batch, TaskTimeoutError);
    // a's result was delivered to its waiter, and the batch threw it away. It must still be there.
    assert.deepEqual(await client.wait(a), { id: a, status: "success", results: { code: "A" } });
  });

  it("a second wait on a delivered id returns the stored result, as often as asked, without polling", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    const first = client.wait(id);
    api.finish(id, ok("once"));
    const delivered = await first;
    const polls = api.requests("completed").length;
    for (let i = 0; i < 3; i++) assert.deepEqual(await client.wait(id), delivered);
    assert.equal(api.requests("completed").length, polls, "reading a stored result must not poll");
    assert.deepEqual(delivered, { id, status: "success", results: { code: "once" } });
  });

  it("run()'s result can be read again by its id", async (t) => {
    const { api, client } = await harness(t);
    autoFinish(api, { code: "482913" });
    const result = await client.run(task());
    assert.deepEqual(await client.wait(result.id), { id: result.id, status: "success", results: { code: "482913" } });
  });

  it("every waiter for an id gets the result, and so does a reader who comes later", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    const waits = [client.wait(id), client.wait(id), client.wait(id)];
    await until(() => client.stats().waiters === 3);
    api.finish(id, ok("shared"));
    const all = [...(await Promise.all(waits)), await client.wait(id)];
    for (const result of all) assert.equal(result.results?.code, "shared");
  });

  it("an error or timeout result is kept the same way", async (t) => {
    const { api, client } = await harness(t);
    const [a, b] = [await client.createTask(task()), await client.createTask(task())];
    const waits = Promise.all([client.wait(a), client.wait(b)]);
    api.finish(a, { status: "error", results: { errorStatus: "invalid mail task", errorMessage: "bad" } });
    api.finish(b, { status: "timeout" });
    await waits;
    assert.equal((await client.wait(a)).results?.errorStatus, "invalid mail task");
    assert.deepEqual(await client.wait(b), { id: b, status: "timeout" });
  });

  it("what a direct poll() returned is readable by wait(id) afterwards", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.finish(id, ok("polled"));
    const polled = await client.poll();
    assert.equal(polled.length, 1);
    assert.equal((await client.wait(id)).results?.code, "polled");
    assert.equal(api.requests("completed").length, 1);
  });

  it("results of tasks this client didn't create are kept once delivered too", async (t) => {
    const { api, client } = await harness(t);
    const foreign = pad(42);
    const waiting = client.wait(foreign, { group: "g", timeoutMs: 5000 });
    api.push("g", { id: foreign, status: "success", results: { code: "somebody else's" } });
    assert.equal((await waiting).results?.code, "somebody else's");
    assert.equal((await client.wait(foreign, { group: "g", timeoutMs: 100 })).results?.code, "somebody else's");
  });

  it("what poll() returned is the caller's own: changing it changes nothing for wait(id)", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.finish(id, ok("original"));
    const [polled] = await client.poll();
    polled!.results!.code = "scribbled on";
    assert.equal((await client.wait(id)).results?.code, "original");
  });

  it("each caller gets a copy: changing it changes nothing for the next reader", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    const first = client.wait(id);
    api.finish(id, ok("original"));
    const mine = await first;
    mine.results!.code = "scribbled on";
    mine.status = "error";
    assert.deepEqual(await client.wait(id), { id, status: "success", results: { code: "original" } });
  });
});

describe("how long a result stays readable", { concurrency: true }, () => {
  it("until it expires, delivered or not: after the TTL the id is unknown", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { resultTtlMs: 300 } });
    const a = await client.createTask(task());
    const b = await client.createTask(task());
    const waiting = client.wait(a);
    api.finish(a, ok("A"));
    api.finish(b, ok("B"));
    await waiting; // a was handed out; b is stored, nobody took it
    assert.deepEqual([client.stats().retainedResults, client.stats().bufferedResults], [1, 1]);
    await sleep(400);
    for (const id of [a, b]) {
      await assert.rejects(client.wait(id), (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        return true;
      });
    }
    assert.deepEqual([client.stats().retainedResults, client.stats().bufferedResults, client.stats().trackedTasks], [0, 0, 0]);
  });

  it("handed-out results don't count against the live-task limit", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxTrackedTasks: 2 } });
    const [a, b] = [await client.createTask(task()), await client.createTask(task())];
    const waits = Promise.all([client.wait(a), client.wait(b)]);
    api.finish(a, ok("A"));
    api.finish(b, ok("B"));
    await waits;
    // Two results are kept and readable, yet two new tasks fit: only live tasks use up the limit.
    const [c, d] = [await client.createTask(task()), await client.createTask(task())];
    assert.equal(client.stats().trackedTasks, 4);
    await assert.rejects(client.createTask(task()), TooManyTasksError);
    assert.equal((await client.wait(a)).results?.code, "A");
    assert.equal((await client.wait(b)).results?.code, "B");
    void c;
    void d;
  });

  it("is bounded: only the newest maxRetainedResults handed-out results are kept", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxRetainedResults: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await client.createTask(task());
      ids.push(id);
      const waiting = client.wait(id);
      api.finish(id, ok(`r${i}`));
      await waiting;
    }
    assert.equal(client.stats().retainedResults, 2);
    await assert.rejects(client.wait(ids[0]!), InvalidRequestError); // the oldest went
    assert.equal((await client.wait(ids[1]!)).results?.code, "r1");
    assert.equal((await client.wait(ids[2]!)).results?.code, "r2");
  });

  it("a result nobody has taken is never dropped to make room for handed-out ones", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxRetainedResults: 1 } });
    const [waited1, waited2, untaken] = [await client.createTask(task()), await client.createTask(task()), await client.createTask(task())];
    const first = client.wait(waited1);
    api.finish(untaken, ok("nobody asked yet"));
    api.finish(waited1, ok("1"));
    await first;
    const second = client.wait(waited2);
    api.finish(waited2, ok("2"));
    await second; // the retention cap (1) pushes the first handed-out result out
    assert.equal((await client.wait(untaken)).results?.code, "nobody asked yet");
  });
});
