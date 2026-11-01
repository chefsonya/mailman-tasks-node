import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTH_MESSAGE,
  AuthError,
  InvalidRequestError,
  MailmanError,
  NetworkError,
  PayloadTooLargeError,
  PendingLimitError,
  RateLimitError,
  RequestTimeoutError,
  ServerBusyError,
  TaskFailedError,
  TaskTimeoutError,
  TooManyTasksError,
} from "../src/index.js";
import { errorFor, parseRetryAfter } from "../src/transport.js";
import { makeRedactor } from "../src/redact.js";
import { KEY } from "./support/mock-api.js";

const answer = (status: number, body = "", retryAfter = 0) => ({ status, text: body, retryAfter, location: undefined });
const redact = makeRedactor(KEY);

describe("error classes", () => {
  it("all extend MailmanError and Error, and carry their own name", () => {
    const errors: MailmanError[] = [
      new AuthError(),
      new InvalidRequestError("x"),
      new PayloadTooLargeError("x"),
      new RateLimitError("x"),
      new PendingLimitError("x"),
      new ServerBusyError("x"),
      new RequestTimeoutError("x"),
      new NetworkError("x"),
      new TooManyTasksError("x", 1),
      new TaskFailedError("id", "invalid mail task", "bad"),
      new TaskTimeoutError("id", "g", "deadline"),
    ];
    for (const error of errors) {
      assert.ok(error instanceof MailmanError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, error.constructor.name);
      assert.ok(error.stack);
    }
  });

  it("have the statuses of the API", () => {
    assert.equal(new AuthError().status, 401);
    assert.equal(new InvalidRequestError("x").status, 400);
    assert.equal(new PayloadTooLargeError("x").status, 413);
    assert.equal(new RateLimitError("x").status, 429);
    assert.equal(new PendingLimitError("x").status, 429);
    assert.equal(new ServerBusyError("x").status, 503);
    assert.equal(new RequestTimeoutError("x").status, 408);
    assert.equal(new NetworkError("x").status, 0);
  });

  it("keep the pending limit apart from the rate limit, so a handler for one can't swallow the other", () => {
    assert.ok(!(new PendingLimitError("x") instanceof RateLimitError));
    assert.ok(!(new RateLimitError("x") instanceof PendingLimitError));
  });

  it("AuthError carries the friendly message of rule S8 and keeps the server's text", () => {
    const error = new AuthError({ apiMessage: "invalid user API key" });
    assert.equal(error.message, "The key was rejected, or Mailman isn't open on your computer.");
    assert.equal(error.message, AUTH_MESSAGE);
    assert.equal(error.apiMessage, "invalid user API key");
  });

  it("retryAfter is seconds and 0 when absent; cause is kept", () => {
    assert.equal(new RateLimitError("x").retryAfter, 0);
    const cause = new Error("inner");
    const error = new RateLimitError("x", { retryAfter: 7, cause });
    assert.equal(error.retryAfter, 7);
    assert.equal(error.cause, cause);
  });

  it("TaskFailedError and TaskTimeoutError describe the task", () => {
    const failed = new TaskFailedError("abc", "invalid mail task", "mailElements[0].regex: bad");
    assert.deepEqual([failed.taskId, failed.errorStatus, failed.errorMessage], ["abc", "invalid mail task", "mailElements[0].regex: bad"]);
    assert.match(failed.message, /abc.*invalid mail task.*mailElements\[0\]\.regex/);
    const lost = new TaskTimeoutError("abc", "g", "deadline");
    assert.deepEqual([lost.taskId, lost.group, lost.reason], ["abc", "g", "deadline"]);
    assert.match(lost.message, /lost.*Create it again/);
    assert.equal(new TaskTimeoutError("abc", "g", "timeout").reason, "timeout");
    assert.match(new TaskTimeoutError(undefined, "g", "deadline").message, /may exist/);
  });
});

describe("mapping answers to errors", () => {
  it("preserves normal error types and status for HTML and empty error bodies", () => {
    for (const body of ["<html>error</html>", ""]) {
      for (const [status, Class] of [
        [400, InvalidRequestError], [401, AuthError], [408, RequestTimeoutError],
        [413, PayloadTooLargeError], [429, RateLimitError], [503, ServerBusyError],
        [500, MailmanError], [502, MailmanError],
      ] as const) {
        const error = errorFor(answer(status, body), redact);
        assert.equal(error.constructor, Class);
        assert.equal(error.status, status);
      }
    }
  });

  it("maps every documented status to its class", () => {
    const cases: Array<[ReturnType<typeof answer>, new (...args: any[]) => MailmanError, number]> = [
      [answer(400, '{"error":"invalid task JSON"}'), InvalidRequestError, 400],
      [answer(401, '{"error":"invalid user API key"}'), AuthError, 401],
      [answer(408), RequestTimeoutError, 408],
      [answer(413, '{"error":"request body exceeds 64 KiB or could not be read"}'), PayloadTooLargeError, 413],
      [answer(429, '{"error":"rate limit exceeded"}', 12), RateLimitError, 429],
      [answer(429, '{"error":"pending task limit exceeded"}'), PendingLimitError, 429],
      [answer(503, '{"error":"server busy"}', 5), ServerBusyError, 503],
      [answer(500, '{"error":"random generator failed"}'), MailmanError, 500],
      [answer(404), MailmanError, 404],
    ];
    for (const [exchange, Class, status] of cases) {
      const error = errorFor(exchange, redact);
      assert.equal(error.constructor, Class, `status ${status}`);
      assert.equal(error.status, status);
    }
  });

  it("keeps the server's message and Retry-After", () => {
    const error = errorFor(answer(429, '{"error":"rate limit exceeded"}', 12), redact);
    assert.equal(error.apiMessage, "rate limit exceeded");
    assert.equal(error.retryAfter, 12);
    assert.match(error.message, /429.*rate limit exceeded/);
  });

  it("copes with bodies that aren't the documented JSON", () => {
    for (const body of ["<html>bad gateway</html>", "", "null", '{"error":5}', "[1]"]) {
      const error = errorFor(answer(502, body), redact);
      assert.equal(error.status, 502);
      assert.equal(error.apiMessage, undefined);
    }
  });

  it("redacts the key from server messages that echo it", () => {
    const error = errorFor(answer(400, JSON.stringify({ error: `mailFilters[0].comparator has invalid value "${KEY}"` })), redact);
    assert.ok(!error.message.includes(KEY));
    assert.ok(!(error.apiMessage ?? "").includes(KEY));
  });

  it("reports a redirect as a configuration problem", () => {
    const error = errorFor({ ...answer(307), location: "https://elsewhere.example/x" }, redact);
    assert.equal(error.status, 307);
    assert.match(error.message, /redirect.*elsewhere\.example.*baseUrl/);
  });
});

describe("Retry-After", () => {
  it("reads seconds and HTTP dates, and 0 for anything else", () => {
    assert.equal(parseRetryAfter("7"), 7);
    assert.equal(parseRetryAfter(" 60 "), 60);
    assert.equal(parseRetryAfter(null), 0);
    assert.equal(parseRetryAfter(""), 0);
    assert.equal(parseRetryAfter("soon"), 0);
    const in30 = new Date(Date.now() + 30_000).toUTCString();
    const parsed = parseRetryAfter(in30);
    assert.ok(parsed >= 28 && parsed <= 31, String(parsed));
    assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
  });
});
