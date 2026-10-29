import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MailmanTasks, NetworkError } from "../src/index.js";
import { sleep, task } from "./support/harness.js";
import { KEY } from "./support/mock-api.js";

const FAST = { pollIntervalMs: 30, fullPageIntervalMs: 10, backoffBaseMs: 10, backoffMaxMs: 40, maxCreateAttempts: 1 } as const;

describe("a stub fetch can't break the timeout guarantees", { concurrency: true }, () => {
  it("a fetch that never answers and ignores its AbortSignal is still cut at the request timeout", async () => {
    const hung: typeof fetch = () => new Promise<Response>(() => {});
    const client = new MailmanTasks(KEY, { fetch: hung, requestTimeoutMs: 100, timing: FAST });
    for (const call of [() => client.verify(), () => client.createTask(task()), () => client.poll()]) {
      const started = performance.now();
      await assert.rejects(call(), (error: unknown) => error instanceof NetworkError && error.timedOut);
      const took = performance.now() - started;
      assert.ok(took >= 94 && took < 1500, `took ${took}`);
    }
  });

  it("so is a body that never ends", async () => {
    const stalled: typeof fetch = async () => ({ status: 200, headers: new Headers(), text: () => new Promise<string>(() => {}) }) as unknown as Response;
    const client = new MailmanTasks(KEY, { fetch: stalled, requestTimeoutMs: 100, timing: FAST });
    await assert.rejects(client.poll(), (error: unknown) => error instanceof NetworkError && error.timedOut);
  });

  it("the caller's AbortSignal ends a request of a fetch that ignores signals", async () => {
    const hung: typeof fetch = () => new Promise<Response>(() => {});
    const client = new MailmanTasks(KEY, { fetch: hung, timing: FAST });
    const controller = new AbortController();
    const pending = client.createTask(task(), { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 40);
    await assert.rejects(pending, /stop/);
  });

  it("a run's deadline caps a hung create even when the fetch ignores signals", async () => {
    const hung: typeof fetch = () => new Promise<Response>(() => {});
    const client = new MailmanTasks(KEY, { fetch: hung, requestTimeoutMs: 5000, timing: FAST });
    const started = performance.now();
    await assert.rejects(client.run(task(), { timeoutMs: 150 }), /deadline|lost|creation/i);
    assert.ok(performance.now() - started < 1500);
  });

  it("an answer that arrives after the abort is dropped quietly, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      let release: (response: Response) => void = () => undefined;
      const late: typeof fetch = () => new Promise<Response>((resolve) => (release = resolve));
      const client = new MailmanTasks(KEY, { fetch: late, requestTimeoutMs: 60, timing: FAST });
      await assert.rejects(client.verify(), NetworkError);
      release(new Response("{}", { status: 200 })); // too late: nobody is listening any more
      const failing: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
      const other = new MailmanTasks(KEY, { fetch: failing, timing: FAST });
      await assert.rejects(other.verify(), NetworkError);
      await sleep(80);
    } finally {
      process.off("unhandledRejection", record);
    }
    assert.deepEqual(unhandled, []);
  });
});

describe("minimal stubs work", { concurrency: true }, () => {
  it("a response with only status, text() and no headers", async () => {
    const calls: string[] = [];
    const stub: typeof fetch = async (input) => {
      calls.push(String(input));
      return { status: 200, text: async () => (calls.length === 1 ? "{}" : '{"id":"abc","status":"pending"}') } as unknown as Response;
    };
    const client = new MailmanTasks(KEY, { fetch: stub, timing: FAST });
    assert.equal(await client.verify(), true);
    assert.equal(await client.createTask(task()), "abc");
  });

  it("a response with only status and json()", async () => {
    const stub: typeof fetch = async () => ({ status: 200, json: async () => ({}) }) as unknown as Response;
    assert.equal(await new MailmanTasks(KEY, { fetch: stub, timing: FAST }).verify(), true);
  });

  it("a stub that throws synchronously is a network error, not a crash", async () => {
    const stub: typeof fetch = () => {
      throw new TypeError("stub exploded");
    };
    const client = new MailmanTasks(KEY, { fetch: stub, timing: FAST });
    await assert.rejects(client.verify(), (error: unknown) => error instanceof NetworkError && /stub exploded/.test(error.message));
  });
});
