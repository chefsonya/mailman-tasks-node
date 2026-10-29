import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthError, NetworkError, ServerBusyError, TaskTimeoutError } from "../src/index.js";
import { harness, sleep, task, until } from "./support/harness.js";

describe("what a lost task says about why", { concurrency: true }, () => {
  it("names the poll error that is still true: a key rejected the whole time", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.connected = false;
    await assert.rejects(client.wait(id, { timeoutMs: 800 }), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.ok(error.cause instanceof AuthError);
      return true;
    });
  });

  it("names a server that kept failing", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    const busy = { kind: "status", status: 503, body: { error: "server busy" } } as const;
    api.fail("completed", ...Array.from({ length: 50 }, () => busy));
    await assert.rejects(client.wait(id, { timeoutMs: 800 }), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.ok(error.cause instanceof ServerBusyError);
      return true;
    });
  });

  it("a wait that gives up while its poll is still in flight has nothing to blame", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 5000 });
    const id = await client.createTask(task());
    api.fail("completed", { kind: "hang" });
    // The poll hasn't failed, it just hasn't answered yet, and it is left alone: the error carries no cause.
    await assert.rejects(client.wait(id, { timeoutMs: 200 }), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(api.requests("completed")[0]!.closedAt, null, "the poll was cut when the wait gave up");
  });

  it("a poll that did fail, though, is named", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 120 });
    const id = await client.createTask(task());
    api.fail("completed", { kind: "hang" }, { kind: "hang" }, { kind: "hang" }, { kind: "hang" });
    await assert.rejects(client.wait(id, { timeoutMs: 700 }), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.ok(error.cause instanceof NetworkError && error.cause.timedOut, `cause: ${String(error.cause)}`);
      return true;
    });
  });

  it("forgets an old error once a poll succeeds, so a plain timeout doesn't blame a 401 that has healed", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.connected = false;
    const waiting = client.wait(id, { timeoutMs: 700 });
    await until(() => api.requests("completed").length >= 2, 2000, "two 401s");
    api.connected = true; // Mailman is back; the task simply never gets an email
    await assert.rejects(waiting, (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.equal(error.cause, undefined, "the 401 was long gone by the deadline");
      return true;
    });
    assert.ok(api.requests("completed").length >= 4, "it kept polling after the key worked again");
    void sleep;
  });
});
