import * as http from "node:http";
import * as https from "node:https";
import { abortReason } from "./util.js";

/**
 * Whether anybody is still waiting for a request that is in flight. A request that nobody waits for any more is not cut,
 * because the server may be writing results into it that exist nowhere else: it goes on to its end (or its total timeout)
 * and what it carries is kept. It only stops keeping the process alive.
 */
export interface Hold {
  readonly held: boolean;
  /** Called whenever `held` changes. Returns how to stop listening. */
  watch(listener: () => void): () => void;
}

/** A {@link Hold} that the owner switches. It starts held. */
export class Held implements Hold {
  readonly #listeners = new Set<() => void>();
  #held: boolean;

  constructor(held = true) {
    this.#held = held;
  }

  get held(): boolean {
    return this.#held;
  }

  /** Listeners still registered: a request that is over must have taken its own away. For diagnostics and tests. */
  get watching(): number {
    return this.#listeners.size;
  }

  set(held: boolean): void {
    if (held === this.#held) return;
    this.#held = held;
    for (const listener of [...this.#listeners]) listener();
  }

  watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }
}

/** What the client sends. Node's `fetch` accepts this too, so a `fetch` can be injected in place of {@link nodeHttp}. */
export interface HttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
  signal: AbortSignal;
  /** Redirects are never followed: a followed 307 would send a POST twice. */
  redirect: "manual";
  /**
   * While it isn't held, nobody waits for the answer: the request carries on, but its socket stops keeping the process
   * alive. Only {@link nodeHttp} can do that; a `fetch` that is passed in ignores it, and so keeps the process alive.
   */
  hold?: Hold | undefined;
}

/** The part of an HTTP answer the client reads. A `Response` has all of it. */
export interface HttpAnswer {
  status: number;
  headers?: { get(name: string): string | null };
  text?(): Promise<string>;
  json?(): Promise<unknown>;
}

export type HttpCall = (url: string, init: HttpInit) => Promise<HttpAnswer>;

// A full page of 100 results is far below this; it only stops a runaway body.
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

/**
 * The default transport: Node's own `http` / `https`, and nothing else between the client and the wire.
 *
 * Exactly one request goes out per call. There is no automatic retry or replay (Node's `fetch`
 * re-sends a request once after a 421, outside the client's pacing), no redirect is followed,
 * and every request has a connection of its own (`Connection: close`), so a stale keep-alive
 * socket can never reset a create. Aborting the signal destroys the socket. Certificates are
 * verified as Node does by default.
 *
 * With a `hold`, the socket is referenced only while the hold is held, so a request nobody waits for any more
 * doesn't keep the process alive.
 */
export const nodeHttp: HttpCall = (url, init) =>
  new Promise<HttpAnswer>((resolve, reject) => {
    if (init.signal.aborted) return reject(abortReason(init.signal));
    const target = new URL(url);
    const headers: Record<string, string> = { ...init.headers, Connection: "close" };
    if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));

    const request = (target.protocol === "https:" ? https : http).request(target, { method: init.method, headers, agent: false });
    const onAbort = () => request.destroy(abortReason(init.signal) as Error);
    let over = false;
    let unwatch: (() => void) | undefined;
    const settle = (finish: () => void) => {
      over = true;
      init.signal.removeEventListener("abort", onAbort);
      unwatch?.();
      finish();
    };
    init.signal.addEventListener("abort", onAbort, { once: true });

    const { hold } = init;
    if (hold) {
      request.on("socket", (socket) => {
        if (over) return;
        const apply = () => void (hold.held ? socket.ref() : socket.unref());
        apply();
        unwatch = hold.watch(apply);
      });
    }

    request.on("error", (error) => settle(() => reject(error)));
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const truncated = () => settle(() => reject(new Error("The connection closed before the answer was complete.")));
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) request.destroy(new Error("The answer is larger than expected."));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        settle(() =>
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              get(name) {
                const value = response.headers[name.toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : (value ?? null);
              },
            },
            text: async () => text,
          }),
        );
      });
      response.on("error", (error) => settle(() => reject(error)));
      response.on("aborted", truncated);
      response.on("close", () => {
        if (!response.complete) truncated();
      });
    });
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
