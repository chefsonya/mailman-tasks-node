# Changelog

## 0.1.0 (2026-10-29)

First release: the Node.js client for [Mailman's Tasks API](https://getmailman.app/developers).

- `MailmanTasks` with `verify()`, `createTask()`, `poll()`, `wait()`, `run()`, `stats()` and `close()`, and the
  `codeTask` / `linkTask` helpers. Zero runtime dependencies; Node 18 or newer; ESM and CommonJS builds with types.
- One polling loop per group, paced by a single gate: at least 3 s between polls (1 s after a full page of 100),
  `Retry-After`, and exponential backoff, whichever is longest.
- Every result is stored the moment its page arrives and kept for an hour, so a second `wait` for the same id
  returns it again and a result that arrived after its waiter gave up is still there.
- A `GET /completed` that has been sent is never cut by a deadline or by its last waiter leaving, because the
  server deletes the results as it answers; only its own timeout (`requestTimeoutMs`) and `close()` end it. While
  nobody waits it doesn't keep the process alive.
- `createTask` retries only explicit `429` and `503` answers and never after an ambiguous transport failure
  (`NetworkError`), so a task is never created twice by a retry.
- Errors: `MailmanError`, `AuthError`, `InvalidRequestError`, `PayloadTooLargeError`, `RateLimitError`,
  `PendingLimitError`, `ServerBusyError`, `RequestTimeoutError`, `NetworkError`, `TooManyTasksError`,
  `TaskFailedError` and `TaskTimeoutError`. The API key never appears in any of them.
