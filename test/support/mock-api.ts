import http from "node:http";
import type { AddressInfo } from "node:net";

/** A key shaped like a real one (the API wants 32+ characters). */
export const KEY = "mailman-test-key-0123456789abcdefABCDEF";

export interface Wire {
  id: string;
  status: "success" | "error" | "timeout";
  results?: Record<string, string>;
}

/** What the mock does to one request instead of answering it normally. Faults are consumed one per request, in order. */
export type Fault =
  | { kind: "status"; status: number; body?: unknown; headers?: Record<string, string> }
  /** Reset the connection without answering. */
  | { kind: "drop" }
  /** Reset the connection, but only when it already carried an earlier request (a stale keep-alive socket). */
  | { kind: "drop-if-reused" }
  /** Send the headers and part of the body, then reset the connection. */
  | { kind: "truncate"; status?: number }
  /** Send the headers and part of the body, then stall: the connection stays open and the body never ends. */
  | { kind: "stall"; status?: number }
  /** Send the headers, then one byte of body every `everyMs` for as long as the connection lasts: a body that never ends. */
  | { kind: "trickle"; everyMs: number }
  /** Never answer. */
  | { kind: "hang" }
  /** Wait, then answer normally. */
  | { kind: "delay"; ms: number }
  /** Hold the request until `release` settles, then answer normally: lets a test act while the request is in flight. */
  | { kind: "hold"; release: Promise<unknown> }
  /**
   * Create only: accept the task at once, but hold the answer until `release` settles. The task exists, and can finish,
   * while the client is still waiting to read its id.
   */
  | { kind: "hold-response"; release: Promise<unknown> };

export type Route = "create" | "completed" | "verify" | "other";

export interface Seen {
  n: number;
  /** performance.now() on arrival: the same clock the client uses, so gaps compare directly. */
  at: number;
  route: Route;
  method: string;
  /** Request target exactly as it came over the wire, query included. */
  url: string;
  /** The decoded `group` query parameter, null when absent. */
  group: string | null;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Which connection carried it, and how many requests that connection had carried including this one. */
  socket: number;
  served: number;
  /** performance.now() when the connection closed (set later), null while open. */
  closedAt: number | null;
}

const PATHS: Record<string, Route> = {
  "/api/v1/tasks/mail/create": "create",
  "/api/v1/tasks/completed": "completed",
  "/api/v1/user/verify": "verify",
};

/** An in-process stand-in for the hosted Tasks API: same paths, same answers, destructive paging. */
export class MockApi {
  readonly key = KEY;
  /** False answers 401 everywhere, like a desktop that isn't connected. */
  connected = true;
  readonly seen: Seen[] = [];
  readonly faults: Record<"create" | "completed" | "verify", Fault[]> = { create: [], completed: [], verify: [] };
  /** Tasks accepted by create and not finished yet. */
  readonly pending = new Map<string, { group: string; task: Record<string, unknown> }>();
  /** Finished results per group, oldest first. */
  readonly completed = new Map<string, Wire[]>();
  readonly created: Array<{ id: string; task: Record<string, any> }> = [];
  /** Called for every created task; return a result to have the mock finish it after `afterMs`. */
  onCreate: ((task: Record<string, any>, id: string) => { afterMs?: number; result: Omit<Wire, "id"> } | undefined) | undefined;

  readonly #server: http.Server;
  #sockets = 0;
  #ids = 0;
  url = "";

  private constructor() {
    this.#server = http.createServer((req, res) => void this.#handle(req, res));
  }

  static async start(): Promise<MockApi> {
    const api = new MockApi();
    await new Promise<void>((resolve) => api.#server.listen(0, "127.0.0.1", resolve));
    api.url = `http://127.0.0.1:${(api.#server.address() as AddressInfo).port}`;
    return api;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Requests to one route, in arrival order. */
  requests(route: Route): Seen[] {
    return this.seen.filter((s) => s.route === route);
  }

  /** Arrival times of the requests to one route. */
  times(route: Route): number[] {
    return this.requests(route).map((s) => s.at);
  }

  /** Script faults for the next requests to a route. */
  fail(route: "create" | "completed" | "verify", ...faults: Fault[]): this {
    this.faults[route].push(...faults);
    return this;
  }

  /** Finish a created task: its result becomes collectable by the next poll of its group. */
  finish(id: string, outcome: Omit<Wire, "id">): void {
    const entry = this.pending.get(id);
    if (!entry) throw new Error(`no pending task ${id}`);
    this.pending.delete(id);
    this.push(entry.group, { id, ...outcome });
  }

  /** Put a result into a group's completed queue directly. */
  push(group: string, wire: Wire): void {
    const queue = this.completed.get(group) ?? [];
    queue.push(wire);
    this.completed.set(group, queue);
  }

  waiting(group: string): number {
    return this.completed.get(group)?.length ?? 0;
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const at = performance.now();
    const url = new URL(req.url ?? "/", "http://mock");
    const route: Route = PATHS[url.pathname] ?? "other";
    const socket = req.socket as http.IncomingMessage["socket"] & { __id?: number; __served?: number };
    if (socket.__id === undefined) {
      socket.__id = ++this.#sockets;
      socket.once("close", () => {
        const closedAt = performance.now();
        for (const s of this.seen) if (s.socket === socket.__id && s.closedAt === null) s.closedAt = closedAt;
      });
    }
    socket.__served = (socket.__served ?? 0) + 1;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const seen: Seen = {
      n: this.seen.length + 1,
      at,
      route,
      method: req.method ?? "",
      url: req.url ?? "",
      group: url.searchParams.get("group"),
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
      socket: socket.__id,
      served: socket.__served,
      closedAt: null,
    };
    this.seen.push(seen);

    const fault = route === "other" ? undefined : this.faults[route].shift();
    let holdResponse: Promise<unknown> | undefined;
    if (fault) {
      switch (fault.kind) {
        case "status":
          return this.#send(res, fault.status, fault.body, fault.headers);
        case "drop":
          return void req.socket.destroy();
        case "drop-if-reused":
          if (seen.served > 1) return void req.socket.destroy();
          break;
        case "truncate":
          res.writeHead(fault.status ?? 500, { "Content-Type": "application/json", "Content-Length": "200" });
          res.write('{"error":"trunc');
          setTimeout(() => req.socket.destroy(), 5);
          return;
        case "stall":
          res.writeHead(fault.status ?? 200, { "Content-Type": "application/json", "Content-Length": "200" });
          res.write('{"tasks":[');
          return;
        case "trickle": {
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000000" });
          const timer = setInterval(() => res.write(" "), fault.everyMs);
          req.socket.once("close", () => clearInterval(timer));
          return;
        }
        case "hang":
          return;
        case "delay":
          await new Promise((resolve) => setTimeout(resolve, fault.ms));
          break;
        case "hold":
          await fault.release;
          break;
        case "hold-response":
          holdResponse = fault.release;
          break;
      }
    }

    if (route === "other") return this.#send(res, 404);
    if (req.headers.authorization !== `Token ${this.key}` || !this.connected) {
      return this.#send(res, 401, { error: "invalid user API key" });
    }
    if (route === "verify") return this.#send(res, 200, {});
    if (route === "completed") {
      const queue = this.completed.get(seen.group ?? "") ?? [];
      return this.#send(res, 200, { tasks: queue.splice(0, 100) });
    }
    return this.#create(res, seen, holdResponse);
  }

  async #create(res: http.ServerResponse, seen: Seen, holdResponse?: Promise<unknown>): Promise<void> {
    let task: Record<string, any>;
    try {
      task = JSON.parse(seen.body);
    } catch {
      return this.#send(res, 400, { error: "invalid task JSON" });
    }
    if (typeof task.email !== "string" || task.email.trim() === "") return this.#send(res, 400, { error: "email is required" });
    const id = (++this.#ids).toString(16).padStart(32, "0");
    this.pending.set(id, { group: task.group ?? "", task });
    this.created.push({ id, task });
    const plan = this.onCreate?.(task, id);
    if (plan) setTimeout(() => this.pending.has(id) && this.finish(id, plan.result), plan.afterMs ?? 0);
    if (holdResponse) await holdResponse;
    this.#send(res, 200, { id, status: "pending" });
  }

  #send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, text === "" ? headers : { "Content-Type": "application/json", ...headers });
    res.end(text);
  }
}
