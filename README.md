# mailman-tasks

The official Node.js client for [Mailman's hosted Tasks API](https://getmailman.app/developers).

Your bot needs the verification code or login link a website just emailed to an address. Instead of
logging in to the mailbox, it creates a **task** (the address, how to recognise the email, what to
extract) and the user's running Mailman finds the email and sends back the values. The mailbox and
its password never leave the user's computer.

```ts
import { MailmanTasks, codeTask } from "mailman-tasks";

const mailman = new MailmanTasks(process.env.MAILMAN_TASKS_KEY!, { group: "signup-bot" });

const { results } = await mailman.run(
  codeTask({ email: "alias@example.com", from: "noreply@example.com", subjectIncludes: "verification code" }),
);
console.log("code:", results.code);
```

- Zero runtime dependencies. Node 18 or newer (requests go out through Node's own `http`/`https`). ESM and CommonJS, with types.
- The API is wire-compatible with AYCD's Inbox Tasks API. The contract, the rules this client follows
  (M1 to M13 and S1 to S8, cited below as "rule M7" and so on) and the error table are in the developer guide at
  [getmailman.app/developers](https://getmailman.app/developers), also as one Markdown page:
  [getmailman.app/tasks-api.md](https://getmailman.app/tasks-api.md).
- Needs Mailman 0.1.35 or newer on the user's computer, signed in, open and connected: that is what answers the tasks.

## Installation

```sh
npm install mailman-tasks
```

Node 18 or newer. It loads from ESM and from CommonJS, and ships its own TypeScript types:

```js
const { MailmanTasks, codeTask } = require("mailman-tasks"); // CommonJS
```

## Get your API key

The key is the user's own, from their Mailman: **Settings → Tasks API → Copy**. Tasks are answered
by that person's Mailman, so it has to be **open** (signed in and connected) while your bot waits. If it isn't, or
the key is wrong, the API answers `401` and the client throws `AuthError` ("The key was rejected, or Mailman isn't
open on your computer."). Read the key from your configuration; the client never logs it, never puts it in a URL, and
removes it from every error message.

## Quick start

```ts
import { MailmanTasks, AuthError, TaskFailedError, TaskTimeoutError, codeTask, linkTask } from "mailman-tasks";

const mailman = new MailmanTasks(key, { group: "signup-bot" });

// When a user pastes their key: is it valid, and is their Mailman open? (rule S1)
try {
  await mailman.verify();
} catch (error) {
  if (error instanceof AuthError) console.error(error.message); // "The key was rejected, or Mailman isn't open on your computer."
  throw error;
}

// receivedAt defaults to the moment of this call, so older mail can't answer (see the note on receivedAt below).
try {
  const { results } = await mailman.run(
    codeTask({ email: "alias@example.com", from: "noreply@example.com", subjectIncludes: "verification code" }),
  );
  console.log(results.code);
} catch (error) {
  if (error instanceof TaskTimeoutError) {
    // No email in time. Trigger a fresh one (the site's "resend code") and run again.
  } else if (error instanceof TaskFailedError) {
    console.error(error.errorStatus, error.errorMessage);
  } else {
    throw error;
  }
}

// A login link instead of a code: results.link
const { results } = await mailman.run(
  linkTask({ email: "alias@example.com", from: "noreply@example.com", subjectIncludes: "Sign in", linkIncludes: "/login" }),
);
```

### Your own task

`codeTask` and `linkTask` build the two common tasks. For anything else write the task yourself; its fields are
the API's (see the developer docs) and it is checked on your side before it is sent:

```ts
await mailman.run({
  email: "alias@example.com",
  timeout: 120, // seconds, 1 to 3600; the default here is 300
  mailFilters: [
    { target: "from", comparator: "includes", value: "noreply@example.com" },
    { target: "subject", comparator: "includes", value: "verification code" },
  ],
  mailElements: [{ name: "otpCode", target: "body", regex: "\\b\\d{6}\\b" }], // JSON needs the backslashes doubled
});
```

`receivedAt` defaults to the moment of the call, which is right when you create the task before the email is
triggered. If you trigger the email first, take `const receivedAt = Math.floor(Date.now() / 1000)` just before
triggering it and pass that (rule S3), so a fast email can't be older than the task.

`receivedAt` and every other time value are in **seconds** (`Math.floor(Date.now() / 1000)`, never
`Date.now()`); a millisecond value is refused rather than sent, because it would match no email.

## API

```ts
new MailmanTasks(apiKey, options?)
```

| Option | Default | |
| --- | --- | --- |
| `group` | `"default"` | The group tasks are created in and waited on. |
| `baseUrl` | `https://tasks.getmailman.app` | For tests and advanced use. Plain `http` is accepted only for `localhost`. |
| `requestTimeoutMs` | `15000` | Total timeout of every HTTP request, from its start: connecting, the headers and the whole body. Besides `close()`, it is the only thing that ends a poll in flight. |
| `fetch` | Node's `http`/`https` | Inject your own, for tests. The default sends one request per connection, follows no redirects and never replays a request; a `fetch` you pass is used as it is (Node's global one re-sends a request once after a 421, outside this client's pacing). |
| `userAgent` | `mailman-tasks-node/0.1.0` | |
| `timing`, `limits` | the API's rules | See [Testing your code](#testing-your-code). |

| Method | |
| --- | --- |
| `verify()` | `true`, or throws `AuthError` on a 401. |
| `createTask(task)` | Creates the task, returns its id. `receivedAt` defaults to now, `timeout` to **300 s** (the API's own default is 3600; the maximum is 3600), `group` to the client's group. |
| `wait(id, { timeoutMs?, deadline?, signal?, group? })` | The task's result, whatever its status. Throws `TaskTimeoutError` when the deadline passes (default: the task's `timeout` + 15 s, counted from its creation). A result is kept for an hour after it arrives, so calling `wait` again for a delivered id returns it again. The deadline, like the `signal`, ends this call only: a poll in flight is never cut by it ([details](#a-poll-that-was-sent-is-never-cut)). |
| `run(task, { timeoutMs?, deadline?, signal? })` | `createTask` then `wait`. Returns `{ id, status: "success", results }`; throws `TaskFailedError` for `status: "error"` and `TaskTimeoutError` for `"timeout"` or a passed deadline. A `timeoutMs`/`deadline` bounds the whole call, creation and its retries included. |
| `poll(group?, { signal?, timeoutMs? })` | One destructive `GET /completed`: the low-level call. What it returns is gone from the server, so **store it** (rule M7). A `signal` ends the call, but not a request that is already out: that finishes in the background and stores what it carries. |
| `stats()`, `close()` | What the client holds. `close()` stops everything: in-flight requests are aborted (their sockets closed) and **what a poll in flight was carrying is discarded**, retry sleeps end and no further attempt is made, polling stops, every `wait` in progress is rejected, and the client refuses new calls. |

`wait` and `run` take an `AbortSignal`: it ends that call (see [below](#a-poll-that-was-sent-is-never-cut) for what it
leaves running). `createTask` takes one too, and it also stops the sleeps between retries when it fires, and abandons
the POST. `close()` does the same for the whole client: its signal is combined with yours for every request and every
retry sleep, so nothing is sent after it. It is the one thing that cuts a poll in flight.

A task id that **this client didn't create** (another process made it) needs `timeoutMs` or `deadline`, and
`group` if it isn't the client's group: `wait(id, { group: "x", timeoutMs: 60_000 })`.
For its own tasks the client remembers the group and the deadline, and a different `group` is an error.

## Concurrency: one polling loop per group

Every `wait` and `run` of a group shares **one** polling loop, so a thousand concurrent `run()` calls cost one
request every few seconds, not a thousand.

- The loop starts with the first waiter and stops when none is left (a poll already in flight finishes first, and
  its results are stored: see [below](#a-poll-that-was-sent-is-never-cut)).
- It polls every **3 s**, or after **1 s** when the last page was full (100 results).
- Results are routed to waiters by task id. Every result is **stored the moment its page arrives**, before any
  waiter is told, and kept for an hour (see [Results are kept](#results-are-kept)).
- Two loops on one group split its results between them, each result going to only one (rule M6). So use
  **one client per key and group**, and a different `group` per independent process or job.
- A `wait` on a group never touches another group's results, and each group is paced on its own.

**A task's `group` decides where its `wait` polls.** `run({ ..., group: "x" })` creates and polls `"x"`.

## Results are kept

A result leaves the server in the response that carries it (rule M7), so this client holds the only copy. It
therefore stores the whole page before it tells any waiter, and keeps every result for **an hour** after it arrived:

- A `wait` called after the result arrived returns it at once, with no polling.
- A `wait` called again for an id that was already delivered returns the same result again. That is what keeps a
  `Promise.all([wait(a), wait(b)])` safe: if `b` times out and rejects the batch, `a`'s result is still there.
- That includes a page that arrives after every waiter has given up: the poll finishes in the background, stores
  what it got, and a later `wait` for any of those ids returns it without another poll.
- Each caller gets its own copy, so changing one changes nothing for the next reader.
- A fast task can finish, and a shared poll can collect its result, before the answer to its create has been read. The
  result is the task's own as soon as the create is registered: it counts, is protected and expires with its task.

Memory stays bounded without dropping what you might still need:

- A result nobody has taken yet is never evicted to make room. Instead a create beyond `limits.maxTrackedTasks` live
  tasks (pending, or with a result nobody has taken) is refused with `TooManyTasksError`, before it is sent. The one
  exception is results of tasks this client didn't create: only `limits.maxUnclaimedResults` of those are kept, the
  oldest dropped first.
- A result already handed out stops counting against `maxTrackedTasks`. The newest `limits.maxRetainedResults` of
  them are kept for repeat reads, the oldest dropped first.
- After the hour, or once evicted, an id is unknown again: `wait(id)` then needs an explicit deadline like any id
  this client didn't create.

## Pacing, retries and deadlines

All pacing of a group's `/completed` lives in one gate, shared by the loop, a restarted loop, direct `poll()`
calls and every retry. Between any two requests it waits the **longest** of: 3 s (1 s after a full page),
`Retry-After`, and the backoff (1, 2, 4 … up to 30 s, with jitter that only adds). A `429 Retry-After: 1`
therefore does not bring a re-poll after one second.

| Answer while waiting | The loop |
| --- | --- |
| `401` | Keeps polling about every 10 s until the deadline: Mailman may be reconnecting (rule M11). If it never recovers, `TaskTimeoutError.cause` is the `AuthError`. |
| `429` | Waits `Retry-After`. |
| `408`, `421`, `5xx`, dropped connection, truncated or unreadable answer | Backs off and tries again, through the same gate. |
| `400`, `404`, other `4xx`, a redirect | Not retried: the waits fail with the error. |

`createTask` is stricter, because a repeated create can make the task twice:

- It retries **only explicit `429` and `503` answers**, sleeping the longer of the backoff and `Retry-After`,
  about 3 attempts in all.
- It **never** retries after a dropped connection, a reset, a truncated answer or its own request timeout: the
  task may exist. That throws `NetworkError` (`requestMayHaveBeenSent` tells you if the request provably never left).
- It never retries `400`, `413`, `401` or `pending task limit exceeded`.

Deadlines are measured on a monotonic clock, so a wall-clock jump can't stretch or cut a wait. A deadline caps a
create and its retries: no POST starts after it, no retry sleeps past it, and the POST in flight is abandoned at it
(a create that is abandoned may exist on the server, so it is never retried). It never cuts a `GET /completed` that has
been sent, as the next section explains. When a wait's deadline passes, **the task is lost**: trigger a fresh email
and create the task again (rule M8).

### A poll that was sent is never cut

The server deletes results in the same step that writes the response (rule M7). Cutting a `GET /completed` once it
has gone out, at a waiter's deadline or because the last waiter left, would lose every result in that response,
other tasks' codes included. A bot that runs many tasks per group and times out regularly has a poll in flight at a
deadline some percent of the time, so this is how codes get lost. The rules:

1. **Every request has a total timeout**, `requestTimeoutMs`: counted from the moment it starts and covering the
   connection, the headers and the whole body. That alone bounds a body that trickles in. Besides `close()` it is
   the only thing that ends a poll in flight, so don't set it short.
2. **Deadlines only gate new attempts.** A deadline, or a waiter leaving, decides whether a poll *starts* and
   caps the sleeps between polls. It never shortens or aborts one that is in flight.
3. **A waiter returns on time.** `wait` throws `TaskTimeoutError` at its deadline without waiting for the poll in
   flight. That poll finishes in the background and stores its results, kept for an hour, so a later `wait` returns
   them with no further poll.
4. **No waiters left.** The poll in flight finishes and stores its results, then the loop stops: no new poll. It
   doesn't keep the process alive either: its socket and timers are unreferenced while nobody waits (a `wait`
   or a `poll()` that starts takes them back), so a short script still exits promptly. (A `fetch` you inject can't
   be unreferenced by this client.)
5. **`close()` aborts everything**, a poll in flight included, and **the results it was carrying are discarded**:
   the server had already deleted them. So close a client once nothing more is expected, not while a wait you
   care about is still open. For the same reason, cancelling a direct `poll({ signal })` only stops *that call*
   from waiting: the request goes on and stores what it gets.

Nothing in the HTTP layer retries behind the pacing's back. The default transport is Node's `http`/`https`: exactly
one request per call, one connection per request (so no stale keep-alive socket can reset a create), redirects never
followed (a followed 307 would send a POST twice), and no automatic replay. Node's global `fetch` is not used by
default because it re-sends a request once after a `421 Misdirected Request`, about a millisecond later and outside
any pacing; a 421 is now an ordinary answer, retried by the polling loop through the gate and never by a create. If
you pass your own `fetch`, what it does on the wire is up to it.

## Errors

All inherit `MailmanError`, which has `status` (0 when there was no HTTP answer), `apiMessage` (the server's
`{"error": …}` text) and `retryAfter` (seconds, 0 if absent).

| Class | When |
| --- | --- |
| `AuthError` | 401. The message is the friendly one: "The key was rejected, or Mailman isn't open on your computer." |
| `InvalidRequestError` | 400, or a task that would be answered 400, caught before sending. Never retried. |
| `PayloadTooLargeError` | 413 (the task is over 64 KiB). |
| `RateLimitError` | 429 `rate limit exceeded`; `retryAfter` is the wait. |
| `PendingLimitError` | 429 `pending task limit exceeded`: the key has 10000 pending tasks. Collect results first. Never a `RateLimitError`, never retried. |
| `ServerBusyError` | 503. |
| `RequestTimeoutError` | 408. |
| `NetworkError` | No answer: refused, reset, dropped, truncated, or this client's own timeout (`timedOut`). |
| `TaskFailedError` | The task finished with `status: "error"`: `errorStatus`, `errorMessage`, `taskId`. |
| `TaskTimeoutError` | `reason: "timeout"` (the server timed the task out) or `"deadline"` (lost). Has `taskId` and `group`. |
| `TooManyTasksError` | The client already tracks `limits.maxTrackedTasks` live tasks (pending, or with a result nobody has taken); nothing was sent. |

The key never appears in an error: not in messages, `cause` chains, stacks or `util.inspect` output,
including messages that echo back a value the server or the validator rejected, and the ids and group names
that errors carry as fields.

## Limits (the API's)

| What | Limit |
| --- | --- |
| Any string in a task | 1024 characters |
| Filters, elements, and `orValues` per filter | 10 each |
| Task `timeout` | 3600 s |
| Create request body | 64 KiB |
| Results per poll | 100, oldest first |
| A result value | 8192 characters (longer values are cut) |
| Uncollected results | dropped by the server after 1 hour |
| Pending tasks per key | 10000 |
| Requests per minute | 5000 per IP address, 10000 per key |

The client checks the first four before it sends. A group polled every 3 s costs 20 requests a minute however many tasks wait in it.

## Not part of the API

There is no endpoint to cancel a task, fetch one by id, acknowledge results or list pending tasks, and no
webhooks or sandbox. Don't call the API from browser JavaScript: there are no CORS headers.

## Testing your code

Pass a `fetch` to run your bot against a stub (the client reads `status`, `headers.get()` and `text()` or `json()`
from what it returns), or point `baseUrl` at a local server.
`timing` and `limits` exist for that; lowering `timing.pollIntervalMs` below 3000 against the hosted API
breaks its rules (M5) and gets you rate-limited.

```ts
const mailman = new MailmanTasks("test-key-0123456789abcdef0123456789abcdef", {
  baseUrl: "http://127.0.0.1:8080",
  timing: { pollIntervalMs: 50, fullPageIntervalMs: 10, backoffBaseMs: 10, deadlineGraceMs: 100 },
});
```

## Development

```sh
git clone https://github.com/chefsonya/mailman-tasks-node.git
cd mailman-tasks-node
npm ci
npm test         # build (ESM + CJS), compile the tests, run them with node:test
```

The unit tests run against a mock HTTP server written in Node that emulates the API (destructive paging,
401/429/503 with `Retry-After`, dropped and truncated connections, hung requests). They need no network. Source:
`src/`; tests: `test/`.

## Issues, security and changes

Bugs and questions: [GitHub issues](https://github.com/chefsonya/mailman-tasks-node/issues). Security problems:
please report them privately, as [SECURITY.md](SECURITY.md) describes. What changed in each version:
[CHANGELOG.md](CHANGELOG.md).

## License

MIT, Copyright (c) 2026 Mailman. See [LICENSE](LICENSE).
