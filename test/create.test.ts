import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthError,
  InvalidRequestError,
  MailmanError,
  MailmanTasks,
  NetworkError,
  PayloadTooLargeError,
  PendingLimitError,
  RateLimitError,
  RequestTimeoutError,
  ServerBusyError,
  TaskTimeoutError,
} from "../src/index.js";
import { FAST, gaps, harness, sleep, task, TOLERANCE, until } from "./support/harness.js";
import { MockApi } from "./support/mock-api.js";

describe("createTask: request and defaults", { concurrency: true }, () => {
  it("sends the documented headers and fills in the defaults", async (t) => {
    const { api, client } = await harness(t);
    const before = Math.floor(Date.now() / 1000);
    const id = await client.createTask(task());
    assert.match(id, /^[0-9a-f]{32}$/);

    const [seen] = api.requests("create");
    assert.equal(seen!.method, "POST");
    assert.equal(seen!.url, "/api/v1/tasks/mail/create");
    assert.equal(seen!.headers.authorization, `Token ${api.key}`);
    assert.equal(seen!.headers["user-agent"], "mailman-tasks-node/0.1.0");
    assert.equal(seen!.headers["content-type"], "application/json");
    const body = JSON.parse(seen!.body);
    assert.equal(body.group, "default");
    assert.equal(body.timeout, 300);
    // M4: seconds, not milliseconds.
    assert.ok(body.receivedAt >= before && body.receivedAt <= before + 2, `receivedAt ${body.receivedAt}`);
    assert.ok(body.receivedAt < 1e11);
    assert.deepEqual(body.mailFilters, task().mailFilters);
    assert.deepEqual(body.mailElements, task().mailElements);
  });

  it("uses an explicit group, timeout and receivedAt, and the client's group option", async (t) => {
    const { api, make } = await harness(t);
    await make({ group: "signup-bot" }).createTask(task());
    await make().createTask(task({ group: "other", timeout: 90, receivedAt: 1_700_000_000 }));
    const [first, second] = api.requests("create").map((s) => JSON.parse(s.body));
    assert.equal(first.group, "signup-bot");
    assert.deepEqual([second.group, second.timeout, second.receivedAt], ["other", 90, 1_700_000_000]);
  });

  it("never puts the key in the URL or the body", async (t) => {
    const { api, client } = await harness(t);
    await client.createTask(task());
    for (const seen of api.seen) {
      assert.ok(!seen.url.includes(api.key));
      assert.ok(!seen.body.includes(api.key));
    }
  });

  it("validates before sending: nothing reaches the server", async (t) => {
    const { api, client } = await harness(t);
    await assert.rejects(client.createTask(task({ email: "" })), InvalidRequestError);
    await assert.rejects(client.createTask(task({ receivedAt: Date.now() })), /seconds, not milliseconds/);
    await assert.rejects(client.createTask(task({ mailFilters: [] })), InvalidRequestError);
    assert.equal(api.seen.length, 0);
  });
});

describe("createTask: retries only what is safe", { concurrency: true }, () => {
  it("retries a 503 and a 429, waiting at least Retry-After", async (t) => {
    const { api, client } = await harness(t);
    api.fail(
      "create",
      { kind: "status", status: 503, headers: { "Retry-After": "1" }, body: { error: "server busy" } },
      { kind: "status", status: 429, headers: { "Retry-After": "1" }, body: { error: "rate limit exceeded" } },
    );
    const id = await client.createTask(task());
    assert.match(id, /^[0-9a-f]{32}$/);
    const times = api.times("create");
    assert.equal(times.length, 3);
    for (const gap of gaps(times)) assert.ok(gap >= 1000 - TOLERANCE, `slept only ${gap} ms`);
    // The task was created once.
    assert.equal(api.created.length, 1);
  });

  it("backs off 1, 2, 4 ... when there is no Retry-After, with jitter that only adds", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { backoffBaseMs: 40, backoffMaxMs: 1000, maxCreateAttempts: 4 } });
    const busy = { kind: "status", status: 503, body: { error: "server shutting down" } } as const;
    api.fail("create", busy, busy, busy);
    await client.createTask(task());
    const [a, b, c] = gaps(api.times("create"));
    for (const [gap, step] of [[a!, 40], [b!, 80], [c!, 160]] as const) {
      assert.ok(gap >= step - TOLERANCE, `gap ${gap} < ${step}`);
      assert.ok(gap <= step * 1.25 + 400, `gap ${gap} far above ${step * 1.25}`);
    }
  });

  it("caps the backoff", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { backoffBaseMs: 30, backoffMaxMs: 60, maxCreateAttempts: 5 } });
    const busy = { kind: "status", status: 503 } as const;
    api.fail("create", busy, busy, busy, busy);
    await client.createTask(task());
    const [, , c, d] = gaps(api.times("create"));
    for (const gap of [c!, d!]) assert.ok(gap >= 60 - TOLERANCE && gap <= 60 * 1.25 + 400, `gap ${gap}`);
  });

  it("gives up after three attempts and throws the last error", async (t) => {
    const { api, client } = await harness(t);
    const busy = { kind: "status", status: 503, body: { error: "server busy" } } as const;
    api.fail("create", busy, busy, busy, busy, busy);
    await assert.rejects(client.createTask(task()), (error: unknown) => {
      assert.ok(error instanceof ServerBusyError);
      assert.equal(error.status, 503);
      assert.equal(error.apiMessage, "server busy");
      return true;
    });
    assert.equal(api.requests("create").length, 3);
    assert.equal(api.created.length, 0);
  });

  it("never retries a 400, 413, 401, 408, 500 or the pending limit", async (t) => {
    const cases: Array<[number, unknown, Record<string, string>, new (...a: any[]) => MailmanError]> = [
      [400, { error: "invalid task JSON" }, {}, InvalidRequestError],
      [413, { error: "request body exceeds 64 KiB or could not be read" }, {}, PayloadTooLargeError],
      [401, { error: "invalid user API key" }, {}, AuthError],
      [408, undefined, {}, RequestTimeoutError],
      [500, { error: "random generator failed" }, {}, MailmanError],
      [429, { error: "pending task limit exceeded" }, {}, PendingLimitError],
    ];
    for (const [status, body, headers, Class] of cases) {
      const { api, client } = await harness(t);
      api.fail("create", { kind: "status", status, body, headers }, { kind: "status", status: 503 });
      await assert.rejects(client.createTask(task()), (error: unknown) => {
        assert.equal((error as MailmanError).constructor, Class, `status ${status}`);
        assert.equal((error as MailmanError).status, status);
        return true;
      });
      assert.equal(api.requests("create").length, 1, `status ${status} was retried`);
      assert.equal(api.created.length, 0);
    }
  });

  it("keeps Retry-After on the error, and doesn't confuse the pending limit with a rate limit", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { maxCreateAttempts: 1 } });
    api.fail("create", { kind: "status", status: 429, headers: { "Retry-After": "30" }, body: { error: "rate limit exceeded" } });
    await assert.rejects(client.createTask(task()), (error: unknown) => {
      assert.ok(error instanceof RateLimitError);
      assert.ok(!(error instanceof PendingLimitError));
      assert.equal(error.retryAfter, 30);
      return true;
    });
  });

  it("does not sleep through a Retry-After above maxRetryAfterMs; it gives up at once", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { maxRetryAfterMs: 1000 } });
    api.fail("create", { kind: "status", status: 429, headers: { "Retry-After": "5" }, body: { error: "rate limit exceeded" } });
    const started = performance.now();
    await assert.rejects(client.createTask(task()), RateLimitError);
    assert.ok(performance.now() - started < 2500, "slept through a 5 s Retry-After");
    assert.equal(api.requests("create").length, 1);
  });

  it("sleeps the longer of the backoff and Retry-After (M9): Retry-After longer", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { backoffBaseMs: 10, backoffMaxMs: 50 } });
    api.fail("create", { kind: "status", status: 503, headers: { "Retry-After": "1" } });
    await client.createTask(task());
    assert.ok(gaps(api.times("create"))[0]! >= 1000 - TOLERANCE);
  });

  it("sleeps the longer of the backoff and Retry-After (M9): backoff longer", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { backoffBaseMs: 1500, backoffMaxMs: 3000 } });
    api.fail("create", { kind: "status", status: 429, headers: { "Retry-After": "1" }, body: { error: "rate limit exceeded" } });
    await client.createTask(task());
    assert.ok(gaps(api.times("create"))[0]! >= 1500 - TOLERANCE, "slept only the Retry-After");
  });
});

describe("createTask: ambiguous failures are never retried", { concurrency: true }, () => {
  const settle = async (api: MockApi, expected = 1) => {
    // Long enough for any retry to have happened if the client were going to make one.
    await sleep(4 * FAST.backoffMaxMs!);
    assert.equal(api.requests("create").length, expected, "the create was repeated");
  };

  it("a dropped connection", async (t) => {
    const { api, client } = await harness(t);
    api.fail("create", { kind: "drop" });
    await assert.rejects(client.createTask(task()), (error: unknown) => {
      assert.ok(error instanceof NetworkError);
      assert.equal(error.status, 0);
      assert.equal(error.requestMayHaveBeenSent, true);
      assert.equal(error.timedOut, false);
      return true;
    });
    await settle(api);
  });

  it("every create has a connection of its own, so a stale keep-alive socket can't reset one", async (t) => {
    const { api, client } = await harness(t);
    await client.createTask(task());
    api.fail("create", { kind: "drop-if-reused" }); // would reset a create that reused a connection
    await client.createTask(task());
    const creates = api.requests("create");
    assert.deepEqual(creates.map((s) => s.served), [1, 1], "a connection carried two requests");
    assert.notEqual(creates[0]!.socket, creates[1]!.socket);
    assert.equal(creates[0]!.headers.connection, "close");
    assert.equal(api.created.length, 2);
  });

  it("a truncated answer: the task may exist, so the create must not repeat", async (t) => {
    const { api, client } = await harness(t);
    api.fail("create", { kind: "truncate", status: 200 });
    await assert.rejects(client.createTask(task()), NetworkError);
    await settle(api);
  });

  it("the client's own request timeout", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 120 });
    api.fail("create", { kind: "hang" });
    const started = performance.now();
    await assert.rejects(client.createTask(task()), (error: unknown) => {
      assert.ok(error instanceof NetworkError);
      assert.equal(error.timedOut, true);
      assert.equal(error.requestMayHaveBeenSent, true);
      return true;
    });
    const took = performance.now() - started;
    assert.ok(took >= 120 - TOLERANCE && took < 1500, `took ${took}`);
    await settle(api);
    // The client closed the connection when it gave up.
    await until(() => api.requests("create")[0]!.closedAt !== null, 2000, "the connection to close");
  });

  it("a refused connection says the request never left", async (t) => {
    const { api, make } = await harness(t);
    const dead = await MockApi.start();
    const url = dead.url;
    await dead.close();
    const client = make({ baseUrl: url });
    await assert.rejects(client.createTask(task()), (error: unknown) => {
      assert.ok(error instanceof NetworkError);
      assert.equal(error.requestMayHaveBeenSent, false);
      return true;
    });
    assert.equal(api.seen.length, 0);
  });

  it("a 200 whose body can't be read: the task exists, and the error says so", async (t) => {
    const { api, client } = await harness(t);
    api.fail("create", { kind: "status", status: 200, body: "not json" });
    await assert.rejects(client.createTask(task()), (error: unknown) => {
      assert.ok(error instanceof MailmanError);
      assert.match(error.message, /may exist/);
      return true;
    });
    assert.equal(api.requests("create").length, 1);
  });
});

describe("createTask: cancellation and deadlines", { concurrency: true }, () => {
  it("an AbortSignal that fires while it sleeps between attempts stops further POSTs", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { backoffBaseMs: 600, backoffMaxMs: 1200, maxCreateAttempts: 5 } });
    const busy = { kind: "status", status: 503 } as const;
    api.fail("create", busy, busy, busy, busy);
    const controller = new AbortController();
    const started = performance.now();
    const pending = client.createTask(task(), { signal: controller.signal });
    await until(() => api.requests("create").length === 1);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
    assert.ok(performance.now() - started < 550, "did not wake up at the abort");
    await sleep(800); // past the first backoff, when the next POST would have gone out
    assert.equal(api.requests("create").length, 1, "a POST went out after the abort");
  });

  it("a signal that is already aborted sends nothing", async (t) => {
    const { api, client } = await harness(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.createTask(task(), { signal: controller.signal }), (error: unknown) => (error as Error).name === "AbortError");
    assert.equal(api.seen.length, 0);
  });

  it("an AbortSignal that fires during the POST rejects with the abort and doesn't repeat it", async (t) => {
    const { api, client } = await harness(t);
    api.fail("create", { kind: "hang" });
    const controller = new AbortController();
    const pending = client.createTask(task(), { signal: controller.signal });
    await until(() => api.requests("create").length === 1);
    controller.abort(new Error("stop it"));
    await assert.rejects(pending, /stop it/);
    await sleep(150);
    assert.equal(api.requests("create").length, 1);
  });

  it("run()'s deadline caps the retries: no POST after it, and no sleep that would pass it", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { backoffBaseMs: 40, backoffMaxMs: 40, maxCreateAttempts: 50 } });
    const busy = { kind: "status", status: 503 } as const;
    api.fail("create", ...Array.from({ length: 50 }, () => busy));
    const started = performance.now();
    await assert.rejects(client.run(task(), { timeoutMs: 300 }), (error: unknown) => {
      // The last real answer, or the deadline itself if it passed while a request was in flight.
      assert.ok(error instanceof ServerBusyError || error instanceof TaskTimeoutError, String(error));
      return true;
    });
    const took = performance.now() - started;
    assert.ok(took < 300 + 400, `ran ${took} ms past a 300 ms deadline`);
    const posts = api.times("create");
    assert.ok(posts.length >= 3, "should have retried while there was time");
    for (const at of posts) assert.ok(at - started < 300 + 15, "a POST went out after the deadline");
  });

  it("run()'s deadline caps a Retry-After that doesn't fit: it fails at once instead of sleeping past it", async (t) => {
    const { api, client } = await harness(t);
    api.fail("create", { kind: "status", status: 503, headers: { "Retry-After": "5" }, body: { error: "server busy" } });
    const started = performance.now();
    await assert.rejects(client.run(task(), { timeoutMs: 800 }), ServerBusyError);
    assert.ok(performance.now() - started < 2000, "slept towards a 5 s Retry-After");
    assert.equal(api.requests("create").length, 1);
  });

  it("run()'s deadline caps the request timeout of the POST itself", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 5000 });
    api.fail("create", { kind: "hang" });
    const started = performance.now();
    await assert.rejects(client.run(task(), { timeoutMs: 200 }), (error: unknown) => {
      assert.ok(error instanceof TaskTimeoutError);
      assert.equal(error.reason, "deadline");
      assert.equal(error.taskId, undefined, "creation was never confirmed");
      assert.ok(error.cause instanceof NetworkError, "the transport failure rides along as the cause");
      assert.match(error.message, /may exist/);
      return true;
    });
    const took = performance.now() - started;
    assert.ok(took >= 200 - TOLERANCE && took < 1500, `took ${took}`);
    await until(() => api.requests("create")[0]!.closedAt !== null, 2000, "the POST to be abandoned");
    assert.ok(api.requests("create")[0]!.closedAt! - started < 2000);
  });

  it("an expired deadline sends no POST at all", async (t) => {
    const { api, client } = await harness(t);
    await assert.rejects(client.run(task(), { timeoutMs: 0 }), TaskTimeoutError);
    assert.equal(api.seen.length, 0);
  });
});

describe("verify", { concurrency: true }, () => {
  it("returns true for a valid key", async (t) => {
    const { api, client } = await harness(t);
    assert.equal(await client.verify(), true);
    const [seen] = api.requests("verify");
    assert.equal(seen!.headers.authorization, `Token ${api.key}`);
  });

  it("throws AuthError with the friendly message on 401 (S1, S8), for a wrong key and for a disconnected desktop", async (t) => {
    const { api, client, make } = await harness(t);
    const wrong = new MailmanTasks("some-other-key-that-is-long-enough-0123456789", { baseUrl: api.url, timing: FAST });
    await assert.rejects(wrong.verify(), (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.message, "The key was rejected, or Mailman isn't open on your computer.");
      assert.equal(error.apiMessage, "invalid user API key");
      return true;
    });
    api.connected = false;
    await assert.rejects(client.verify(), AuthError);
    assert.equal(api.requests("verify").length, 2, "a 401 is not retried");
    void make;
  });

  it("retries a 503, a 408 and a dropped connection, because a GET is safe to repeat", async (t) => {
    const { api, client } = await harness(t);
    api.fail("verify", { kind: "status", status: 503 }, { kind: "drop" });
    assert.equal(await client.verify(), true);
    assert.equal(api.requests("verify").length, 3);
    api.fail("verify", { kind: "status", status: 408 });
    assert.equal(await client.verify(), true);
  });

  it("gives up after three attempts", async (t) => {
    const { api, client } = await harness(t);
    const busy = { kind: "status", status: 503 } as const;
    api.fail("verify", busy, busy, busy, busy);
    await assert.rejects(client.verify(), ServerBusyError);
    assert.equal(api.requests("verify").length, 3);
  });

  it("puts a timeout on the request", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 80, timing: { maxCreateAttempts: 1 } });
    api.fail("verify", { kind: "hang" });
    await assert.rejects(client.verify(), (error: unknown) => error instanceof NetworkError && error.timedOut);
  });
});
