import {
  AuthError,
  InvalidRequestError,
  MailmanError,
  NetworkError,
  PayloadTooLargeError,
  PendingLimitError,
  RateLimitError,
  RequestTimeoutError,
  ServerBusyError,
} from "./errors.js";
import type { HttpAnswer, HttpCall, Hold } from "./http.js";
import { sanitizeCause, type Redactor } from "./redact.js";
import { abortReason, isObject, now, refTimer, timerDelay, unrefTimer, type Timer } from "./util.js";

/** One complete HTTP answer. */
export interface Exchange {
  status: number;
  text: string;
  /** Seconds from Retry-After, 0 if absent. */
  retryAfter: number;
  /** The Location header of a redirect. */
  location: string | undefined;
}

export interface ExchangeSpec {
  method: "GET" | "POST";
  /** Path and query, appended to the base URL. */
  path: string;
  body?: string;
  /** The caller's cancellation. */
  signal?: AbortSignal | undefined;
  /**
   * Give up on the request after this long, counted from the moment it starts and covering the connection, the headers
   * and the whole body: a body that trickles in is bounded by it too, since nothing resets it.
   */
  timeoutMs: number;
  /**
   * An absolute monotonic time that also ends the request. For a request that may be abandoned at a deadline, a create:
   * never for a `GET /completed`, which the server answers by deleting what it sends, so once it is out only
   * `timeoutMs` and the caller's `signal` may end it.
   */
  capAt?: (() => number | undefined) | undefined;
  /**
   * Whether anybody is waiting for the answer. While it isn't held the request goes on (nothing here ends it), but neither
   * its timer nor its socket keeps the process alive. Without a hold the request keeps the process alive, as it should
   * when the caller is awaiting it.
   */
  hold?: Hold | undefined;
}

export interface TransportOptions {
  baseUrl: string;
  key: string;
  userAgent: string;
  /** How a request goes out: Node's http/https by default, or a `fetch` the caller injected. */
  call: HttpCall;
  redact: Redactor;
}

// Failures that happen before a request can leave this machine.
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL", "ERR_INVALID_CHAR"]);

/**
 * One HTTP attempt per call, nothing hidden: no retries here, no redirects followed (a followed
 * 307 would send a POST twice), every request on a timer, every failure a typed error. The
 * default `call` (see http.ts) sends exactly one request; an injected `fetch` is used as it is.
 */
export class Transport {
  readonly #options: TransportOptions;

  constructor(options: TransportOptions) {
    this.#options = options;
  }

  async exchange(spec: ExchangeSpec): Promise<Exchange> {
    const { signal } = spec;
    if (signal?.aborted) throw abortReason(signal);

    const controller = new AbortController();
    const startedAt = now();
    let stoppedBy: "caller" | "timer" | undefined;
    let timer: Timer | undefined;

    // A fetch that ignores its signal (a stub, a polyfill) must not outlive the timeout: the call is raced against
    // the abort itself. Listening starts before anything can abort, an already expired cap included.
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    stopped.catch(() => undefined);

    const onCallerAbort = () => {
      stoppedBy ??= "caller";
      controller.abort(abortReason(signal));
    };
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    // The timer keeps the process alive only while somebody waits for the answer.
    const { hold } = spec;
    const applyHold = () => {
      if (timer !== undefined && hold) (hold.held ? refTimer : unrefTimer)(timer);
    };
    const arm = () => {
      const at = now();
      const hard = startedAt + spec.timeoutMs;
      const cap = spec.capAt?.();
      const stopAt = cap === undefined ? hard : Math.min(hard, cap);
      if (at >= stopAt) {
        stoppedBy ??= "timer";
        controller.abort(new Error("request timed out"));
        return;
      }
      timer = setTimeout(arm, timerDelay(stopAt - at));
      applyHold();
    };
    arm();
    const unwatchHold = hold?.watch(applyHold);

    const { key, userAgent, redact } = this.#options;
    const headers: Record<string, string> = {
      Authorization: `Token ${key}`,
      "User-Agent": userAgent,
      Accept: "application/json",
    };
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";

    const attempt = (async (): Promise<Exchange> => {
      // Already out of time: nothing is sent.
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await this.#options.call(this.#options.baseUrl + spec.path, {
        method: spec.method,
        headers,
        body: spec.body,
        signal: controller.signal,
        redirect: "manual",
        ...(hold ? { hold } : {}),
      });
      // The body is part of the request: a stall or a truncation here is a transport failure too.
      const text = await readText(response);
      return {
        status: response.status,
        text,
        retryAfter: parseRetryAfter(response.headers?.get("retry-after")),
        location: response.headers?.get("location") ?? undefined,
      };
    })();
    attempt.catch(() => undefined); // if the abort won the race, a late failure of the attempt is not unhandled

    try {
      return await Promise.race([attempt, stopped]);
    } catch (error) {
      if (stoppedBy === "caller" || (signal?.aborted && stoppedBy === undefined)) throw abortReason(signal);
      throw toNetworkError(error, stoppedBy === "timer", redact);
    } finally {
      clearTimeout(timer);
      unwatchHold?.();
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

async function readText(answer: HttpAnswer): Promise<string> {
  if (typeof answer.text === "function") return answer.text();
  // A minimal stub may only have json().
  return typeof answer.json === "function" ? JSON.stringify(await answer.json()) : "";
}

function toNetworkError(error: unknown, timedOut: boolean, redact: Redactor): NetworkError {
  const cause = sanitizeCause(error, redact) as
    | { message?: string; code?: string; cause?: { code?: string; message?: string } }
    | undefined;
  const code = cause?.cause?.code ?? cause?.code;
  // fetch only says "fetch failed"; the reason is one level down. Node's http puts it on the error itself.
  const detail = [cause?.message, code ?? cause?.cause?.message].filter((part) => typeof part === "string" && part !== "").join(" / ");
  const message = timedOut
    ? "The Tasks API request timed out."
    : `Could not complete the Tasks API request${detail ? `: ${detail}` : "."}`;
  return new NetworkError(redact(message), {
    cause,
    timedOut,
    requestMayHaveBeenSent: timedOut || code === undefined || !NEVER_SENT.has(code),
  });
}

/** Retry-After as seconds: a number of seconds or an HTTP date. 0 when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined): number {
  if (!value) return 0;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function apiMessageOf(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (isObject(body) && typeof body.error === "string") return body.error;
  } catch {
    // Not JSON: a proxy's page, or an empty body (404, 405 and 408 have none).
  }
  return undefined;
}

/** The typed error for a non-2xx answer. Every message is redacted. */
export function errorFor(exchange: Exchange, redact: Redactor): MailmanError {
  const { status, retryAfter } = exchange;
  const apiMessage = apiMessageOf(exchange.text);
  const init = { apiMessage: apiMessage === undefined ? undefined : redact(apiMessage), retryAfter };
  const said = (fallback: string) => redact(`Tasks API ${status}: ${apiMessage ?? fallback}`);
  switch (status) {
    case 400:
      return new InvalidRequestError(said("invalid request"), init);
    case 401:
      return new AuthError(init);
    case 408:
      return new RequestTimeoutError(said("the request took more than 10 seconds"), init);
    case 413:
      return new PayloadTooLargeError(said("request body exceeds 64 KiB"), init);
    case 429:
      return apiMessage !== undefined && /pending task limit/i.test(apiMessage)
        ? new PendingLimitError(said("pending task limit exceeded"), init)
        : new RateLimitError(said("rate limit exceeded"), init);
    case 503:
      return new ServerBusyError(said("service unavailable"), init);
    default:
      if (status >= 300 && status < 400) {
        return new MailmanError(
          redact(`Tasks API answered ${status}, a redirect${exchange.location ? ` to ${exchange.location}` : ""}. Check baseUrl.`),
          { ...init, status },
        );
      }
      return new MailmanError(said("unexpected answer"), { ...init, status });
  }
}
