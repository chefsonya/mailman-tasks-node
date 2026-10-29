import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NetworkError, TaskTimeoutError } from "../src/index.js";
import { harness, holdNextPoll, sleep, task, TOLERANCE, until } from "./support/harness.js";

const ok = (code: string) => ({ status: "success" as const, results: { code } });

// The server deletes results in the same step that writes the response. A poll that has been sent must therefore never
// be cut short by a waiter's deadline or by the last waiter leaving: every result in that response, other tasks' codes
// included, would be lost. Waiters still return on time; the poll finishes in the background and stores what it got.
describe("a poll in flight is never cut by a deadline or a departing waiter", { concurrency: true }, () => {
  it("(a) the earliest waiter's deadline passes: it returns on time, the poll is left alone, and what the late response carries is stored", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const [early, later, other] = [await client.createTask(task()), await client.createTask(task()), await client.createTask(task())];
    const release = holdNextPoll(api);
    const started = performance.now();
    const earlyWait = client.wait(early, { timeoutMs: 150 }).then(() => "resolved" as const, (error: unknown) => error);
    const laterWait = client.wait(later, { timeoutMs: 10_000 });
    await until(() => api.requests("completed").length === 1, 5000, "the poll to be sent");

    // The waiter whose deadline came gives up on time, without waiting for the poll...
    assert.ok((await earlyWait) instanceof TaskTimeoutError);
    assert.ok(performance.now() - started < 1500, "the waiter waited for the poll");
    // ...and the poll in flight is left alone.
    await sleep(200);
    assert.equal(api.requests("completed")[0]!.closedAt, null, "the poll was cut at the waiter's deadline");

    // The late response carries the result of a task nobody waits for, and the one the remaining waiter wants.
    api.finish(other, ok("another task's code"));
    api.finish(later, ok("the remaining waiter's code"));
    release();
    assert.equal((await laterWait).results?.code, "the remaining waiter's code");
    assert.equal(client.stats().bufferedResults, 1, "the other task's code was not stored");

    // Nobody waits any more: the loop stops, and a later wait answers from the store without polling.
    await until(() => client.stats().pollers === 0, 5000, "the loop to stop");
    assert.equal(api.requests("completed").length, 1, "a poll was made after the one in flight");
    assert.equal((await client.wait(other)).results?.code, "another task's code");
    assert.equal(api.requests("completed").length, 1, "wait() polled again");
  });

  it("(b) the last waiter cancels: the poll is left alone, finishes in the background, and its late response is stored", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const [mine, other] = [await client.createTask(task()), await client.createTask(task())];
    const release = holdNextPoll(api);
    const controller = new AbortController();
    const waiting = client.wait(mine, { timeoutMs: 30_000, signal: controller.signal }).then(() => "resolved" as const, (error: unknown) => error);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to be sent");

    controller.abort(new Error("cancelled"));
    assert.equal(((await waiting) as Error).message, "cancelled", "the waiter returns at once");
    await sleep(200);
    assert.equal(api.requests("completed")[0]!.closedAt, null, "the poll was cut when its last waiter left");

    // The late response carries another task's code. It is stored although nobody was waiting when it arrived.
    api.finish(other, ok("another task's code"));
    release();
    await until(() => client.stats().bufferedResults === 1, 5000, "the poll to finish in the background and store its result");
    await until(() => client.stats().pollers === 0, 5000, "the loop to stop");
    await sleep(250); // several poll intervals: no new poll may start with nobody waiting
    assert.equal(client.stats().groups, 0, "the idle group was not tidied away");
    assert.equal(api.requests("completed").length, 1, "a new poll started with nobody waiting");
    assert.equal((await client.wait(other)).results?.code, "another task's code");
    assert.equal(api.requests("completed").length, 1, "wait() polled again");
  });

  it("(c) its only waiter times out: the poll is left alone, finishes in the background, and its late response is stored", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const [mine, other] = [await client.createTask(task()), await client.createTask(task())];
    const release = holdNextPoll(api);
    const started = performance.now();
    const waiting = client.wait(mine, { timeoutMs: 150 }).then(() => "resolved" as const, (error: unknown) => error);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to be sent");

    assert.ok((await waiting) instanceof TaskTimeoutError);
    assert.ok(performance.now() - started < 1500, "the waiter waited for the poll");
    await sleep(200);
    assert.equal(api.requests("completed")[0]!.closedAt, null, "the poll was cut when its only waiter timed out");

    api.finish(other, ok("another task's code"));
    release();
    await until(() => client.stats().bufferedResults === 1, 5000, "the poll to finish in the background and store its result");
    await until(() => client.stats().pollers === 0, 5000, "the loop to stop");
    await sleep(250);
    assert.equal(client.stats().groups, 0, "the idle group was not tidied away");
    assert.equal(api.requests("completed").length, 1, "a new poll started with nobody waiting");
    assert.equal((await client.wait(other)).results?.code, "another task's code");
    assert.equal(api.requests("completed").length, 1, "wait() polled again");
  });

  it("(d) a waiter that arrives after the last one left is served by the poll still in flight, without a new one", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const [first, second] = [await client.createTask(task()), await client.createTask(task())];
    const release = holdNextPoll(api);
    const gaveUp = client.wait(first, { timeoutMs: 150 }).then(() => "resolved" as const, (error: unknown) => error);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to be sent");
    assert.ok((await gaveUp) instanceof TaskTimeoutError); // nobody waits now; the poll is still in flight

    const secondWait = client.wait(second, { timeoutMs: 10_000 });
    api.finish(second, ok("served by the poll already in flight"));
    release();
    assert.equal((await secondWait).results?.code, "served by the poll already in flight");
    await until(() => client.stats().pollers === 0, 5000, "the loop to stop");
    assert.equal(api.requests("completed").length, 1, "the new waiter needed a poll of its own");
  });

  it("(e) a waiter that arrives while a poll nobody waits for is in flight, and isn't served by it, gets a fresh poll", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const [first, second] = [await client.createTask(task()), await client.createTask(task())];
    const release = holdNextPoll(api);
    const gaveUp = client.wait(first, { timeoutMs: 150 }).then(() => "resolved" as const, (error: unknown) => error);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to be sent");
    assert.ok((await gaveUp) instanceof TaskTimeoutError);

    const secondWait = client.wait(second, { timeoutMs: 10_000 });
    release(); // the page in flight is empty: it can't serve the new waiter
    await sleep(20);
    api.finish(second, ok("found by the next poll"));
    assert.equal((await secondWait).results?.code, "found by the next poll");
    assert.equal(api.requests("completed").length, 2, "exactly one more poll was needed");
    await until(() => client.stats().pollers === 0, 5000, "the loop to stop");
  });

  it("a direct poll() that is cancelled while its request is out returns at once, and the request still stores what it carries", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const other = await client.createTask(task());
    const release = holdNextPoll(api);
    const controller = new AbortController();
    const polling = client.poll(undefined, { signal: controller.signal }).then(() => "resolved" as const, (error: unknown) => error);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to be sent");

    controller.abort(new Error("cancelled"));
    assert.equal(((await polling) as Error).message, "cancelled", "the caller returns at once");
    await sleep(200);
    assert.equal(api.requests("completed")[0]!.closedAt, null, "the poll was cut by its caller's signal");

    api.finish(other, ok("another task's code"));
    release();
    await until(() => client.stats().bufferedResults === 1, 5000, "the request to finish in the background and store its result");
    assert.equal(client.stats().retainedResults, 0, "a result that reached nobody was stored as handed out");
    await until(() => client.stats().groups === 0, 5000, "the group the background request ran in to be tidied away");
    assert.equal((await client.wait(other)).results?.code, "another task's code");
    assert.equal(api.requests("completed").length, 1, "wait() polled again");
  });

  it("a direct poll() cancelled while it waits for its turn sends nothing", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const release = holdNextPoll(api);
    const first = client.poll("g");
    await until(() => api.requests("completed").length === 1, 5000, "the first poll to be sent");
    const controller = new AbortController();
    const queued = client.poll("g", { signal: controller.signal }).then(() => "resolved" as const, (error: unknown) => error);
    await sleep(30);
    controller.abort(new Error("cancelled"));
    assert.equal(((await queued) as Error).message, "cancelled");
    release();
    await first;
    await sleep(150);
    assert.equal(api.requests("completed").length, 1, "the cancelled poll was sent anyway");
  });

  it("close() still aborts a poll in flight, and what it was carrying is discarded", async (t) => {
    const { api, make } = await harness(t);
    const client = make();
    const [mine, other] = [await client.createTask(task()), await client.createTask(task())];
    const release = holdNextPoll(api);
    const waiting = client.wait(mine, { timeoutMs: 30_000 }).then(() => "resolved" as const, (error: unknown) => error);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to be sent");
    api.finish(other, ok("lost with the poll"));
    client.close();
    assert.ok(((await waiting) as Error).message.includes("closed"));
    await until(() => api.requests("completed")[0]!.closedAt !== null, 5000, "close() to cut the poll");
    release(); // the server answers a connection that is gone
    await sleep(150);
    assert.equal(client.stats().bufferedResults, 0, "a result of a poll that close() cut was stored");
  });
});

describe("every request has a total timeout", { concurrency: true }, () => {
  it("it is what bounds a poll nobody waits for any more: not the waiter's deadline, and not nothing", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 700 });
    const id = await client.createTask(task());
    api.fail("completed", { kind: "hang" });
    const started = performance.now();
    await assert.rejects(client.wait(id, { timeoutMs: 150 }), TaskTimeoutError);
    await until(() => api.requests("completed")[0]?.closedAt != null, 5000, "the request's own timeout to cut it");
    const openFor = api.requests("completed")[0]!.closedAt! - started;
    assert.ok(openFor >= 700 - 100, `the poll was cut after ${openFor.toFixed(0)} ms, before its own timeout of 700 ms`);
    await until(() => client.stats().pollers === 0, 5000, "the loop to stop");
    await sleep(250);
    assert.equal(api.requests("completed").length, 1, "a new poll started with nobody waiting");
  });

  it("it covers a body that trickles in: the timeout isn't reset by every byte", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 300 });
    api.fail("completed", { kind: "trickle", everyMs: 20 });
    const started = performance.now();
    await assert.rejects(client.poll("g"), (error: unknown) => error instanceof NetworkError && error.timedOut);
    const took = performance.now() - started;
    assert.ok(took >= 300 - TOLERANCE && took < 2500, `took ${took.toFixed(0)} ms`);
  });
});
