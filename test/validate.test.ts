import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidRequestError, PayloadTooLargeError, type TaskInput } from "../src/index.js";
import { makeRedactor, sanitizeCause } from "../src/redact.js";
import { prepareTask } from "../src/validate.js";
import { KEY } from "./support/mock-api.js";

const NOW = 1_793_145_600;
const redact = makeRedactor(KEY);

const good = (): TaskInput => ({
  email: "alias@example.com",
  mailFilters: [{ target: "from", comparator: "includes", value: "noreply@example.com" }],
  mailElements: [{ name: "code", target: "body", regex: "\\b\\d{6}\\b" }],
});

const prepare = (task: unknown, defaultGroup = "default") =>
  prepareTask(task as TaskInput, { defaultGroup, nowSeconds: NOW, redact });

/** The task, changed by `edit`, must be refused with this message. */
function refuses(edit: (task: any) => void, message: RegExp | string): void {
  const task = good();
  edit(task);
  assert.throws(
    () => prepare(task),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError, `expected InvalidRequestError, got ${String(error)}`);
      assert.equal(error.status, 400);
      if (typeof message === "string") assert.equal(error.message, message);
      else assert.match(error.message, message);
      return true;
    },
  );
}

const accepts = (edit: (task: any) => void): void => {
  const task = good();
  edit(task);
  prepare(task);
};

describe("prepareTask defaults", () => {
  it("fills in receivedAt (seconds), timeout 300 and the client's group", () => {
    const prepared = prepare(good(), "bots");
    assert.equal(prepared.group, "bots");
    assert.equal(prepared.timeoutSecs, 300);
    const body = JSON.parse(prepared.json);
    assert.deepEqual([body.group, body.receivedAt, body.timeout], ["bots", NOW, 300]);
  });

  it("keeps an explicit group, including the empty one, and treats undefined/null as 'use the default'", () => {
    assert.equal(prepare({ ...good(), group: "x" }).group, "x");
    assert.equal(prepare({ ...good(), group: "" }).group, "");
    assert.equal(prepare({ ...good(), group: undefined }, "d").group, "d");
    assert.equal(prepare({ ...good(), group: null }, "d").group, "d");
  });

  it("applies the API's timeout rules: 0 and anything above 3600 mean 3600", () => {
    assert.equal(prepare({ ...good(), timeout: 60 }).timeoutSecs, 60);
    assert.equal(prepare({ ...good(), timeout: 3600 }).timeoutSecs, 3600);
    assert.equal(prepare({ ...good(), timeout: 0 }).timeoutSecs, 3600);
    assert.equal(prepare({ ...good(), timeout: 99_999 }).timeoutSecs, 3600);
    // The body carries the value the API will apply, so the wait deadline and the server agree.
    assert.equal(JSON.parse(prepare({ ...good(), timeout: 99_999 }).json).timeout, 3600);
  });

  it("rejects a timeout the API could not read", () => {
    for (const timeout of [-1, 1.5, "60", Number.NaN, Infinity]) {
      refuses((task) => (task.timeout = timeout), "timeout must be a whole number of seconds");
    }
  });

  it("passes fields it doesn't know through, like the API ignores them", () => {
    const body = JSON.parse(prepare({ ...good(), futureField: { a: 1 } }).json);
    assert.deepEqual(body.futureField, { a: 1 });
  });
});

describe("prepareTask mirrors tasks-proto", () => {
  it("accepts 1024 characters and rejects 1025, in every string field", () => {
    const ok = "x".repeat(1024);
    const long = "x".repeat(1025);
    accepts((t) => (t.email = ok));
    refuses((t) => (t.email = long), "email exceeds 1024 characters");
    refuses((t) => (t.group = long), "group exceeds 1024 characters");
    refuses((t) => (t.templateId = long), "templateId exceeds 1024 characters");
    refuses((t) => (t.mailFilters[0].value = long), "mailFilters[0].value exceeds 1024 characters");
    refuses((t) => (t.mailFilters[0].regexReplaceAll = long), "mailFilters[0].regexReplaceAll exceeds 1024 characters");
    refuses((t) => (t.mailFilters[0].orValues = [long]), "mailFilters[0].orValues exceeds 1024 characters");
    refuses((t) => (t.mailElements[0].name = long), "mailElements[0].name exceeds 1024 characters");
    refuses((t) => (t.mailElements[0].selector = long), "mailElements[0].selector exceeds 1024 characters");
    refuses((t) => (t.mailElements[0].regex = long), "mailElements[0].regex exceeds 1024 characters");
  });

  it("counts characters the way the API does: code points, not UTF-16 units", () => {
    accepts((t) => (t.email = "😀".repeat(1024))); // 2048 UTF-16 units
    refuses((t) => (t.email = "😀".repeat(1025)), "email exceeds 1024 characters");
  });

  it("allows 10 filters, 10 elements and 10 orValues, and rejects 11", () => {
    accepts((t) => (t.mailFilters = Array.from({ length: 10 }, () => t.mailFilters[0])));
    refuses((t) => (t.mailFilters = Array.from({ length: 11 }, () => t.mailFilters[0])), "mailFilters has too many entries");
    accepts((t) => (t.mailElements = Array.from({ length: 10 }, () => t.mailElements[0])));
    refuses((t) => (t.mailElements = Array.from({ length: 11 }, () => t.mailElements[0])), "mailElements has too many entries");
    accepts((t) => (t.mailFilters[0].orValues = Array.from({ length: 10 }, (_, i) => `v${i}`)));
    refuses((t) => (t.mailFilters[0].orValues = Array.from({ length: 11 }, (_, i) => `v${i}`)), "orValues has too many entries");
  });

  it("checks every enum, case-sensitively, with the API's wording", () => {
    for (const comparator of ["includes", "excludes", "matches", "findByRegex"]) accepts((t) => (t.mailFilters[0].comparator = comparator));
    refuses((t) => (t.mailFilters[0].comparator = "contains"), 'mailFilters[0].comparator has invalid value "contains"');
    refuses((t) => (t.mailFilters[0].comparator = "Includes"), /invalid value "Includes"/);
    // A filter reads the sender or the subject only; "body" is an element target.
    refuses((t) => (t.mailFilters[0].target = "body"), 'mailFilters[0].target has invalid value "body"');
    for (const target of ["from", "subject", "body"]) accepts((t) => (t.mailElements[0] = { name: "x", target, regex: "." }));
    refuses((t) => (t.mailElements[0].target = "html"), 'mailElements[0].target has invalid value "html"');
    for (const formatter of ["text", "html", "link", "numeric", ""]) accepts((t) => (t.mailElements[0].formatter = formatter));
    refuses((t) => (t.mailElements[0].formatter = "xml"), 'mailElements[0].formatter has invalid value "xml"');
    for (const regexSource of ["pretty", "raw", ""]) accepts((t) => (t.mailElements[0].regexSource = regexSource));
    refuses((t) => (t.mailElements[0].regexSource = "both"), 'mailElements[0].regexSource has invalid value "both"');
  });

  it("requires what the API requires", () => {
    refuses((t) => delete t.email, "email is required");
    refuses((t) => (t.email = "  \t"), "email is required");
    refuses((t) => (t.mailFilters = []), "mailFilters is required");
    refuses((t) => delete t.mailFilters, "mailFilters is required");
    refuses((t) => (t.mailElements = []), "mailElements is required");
    refuses((t) => (t.mailFilters[0].value = ""), "mailFilters[].value is required");
    refuses((t) => (t.mailElements[0].name = ""), "mailElements[].name is required");
    refuses((t) => delete t.mailElements[0].regex, "mailElements[].selector or regex is required");
    accepts((t) => ((t.mailElements[0] = { name: "x", target: "body", selector: ".otp" })));
    accepts((t) => ((t.mailElements[0] = { name: "from", target: "from" })));
    accepts((t) => ((t.mailElements[0] = { name: "subject", target: "subject" })));
  });

  it("rejects wrong types the API would answer 'invalid task JSON' for", () => {
    refuses((t) => (t.email = 5), "email must be a string");
    refuses((t) => (t.mailFilters = "x"), "mailFilters is required");
    refuses((t) => (t.mailFilters[0] = "x"), "mailFilters[0] must be an object");
    refuses((t) => (t.mailFilters[0].value = 5), "mailFilters[0].value must be a string");
    refuses((t) => (t.mailFilters[0].optional = "yes"), "mailFilters[0].optional must be true or false");
    refuses((t) => (t.mailFilters[0].orValues = "a"), "mailFilters[0].orValues must be a list of strings");
    refuses((t) => (t.mailFilters[0].orValues = [1]), "mailFilters[0].orValues must be a list of strings");
    refuses((t) => (t.mailElements[0].penetrate = "no"), "mailElements[0].penetrate must be true or false");
    assert.throws(() => prepare("task"), InvalidRequestError);
    assert.throws(() => prepare(null), InvalidRequestError);
  });

  it("rejects text that isn't valid Unicode (the API's JSON parser would)", () => {
    refuses((t) => (t.email = "a\uD800b"), "email must be valid Unicode text");
    refuses((t) => (t.group = "\uDC00"), "group must be valid Unicode text");
  });
});

describe("prepareTask receivedAt", () => {
  it("accepts seconds and refuses milliseconds, floats and junk", () => {
    assert.equal(JSON.parse(prepare({ ...good(), receivedAt: 1_685_335_507 }).json).receivedAt, 1_685_335_507);
    refuses((t) => (t.receivedAt = Date.now()), /in seconds, not milliseconds/);
    refuses((t) => (t.receivedAt = 1_793_145_600_000), /in seconds, not milliseconds/);
    refuses((t) => (t.receivedAt = Date.now() / 1000), /whole number of seconds/);
    refuses((t) => (t.receivedAt = "1793145600"), /whole number of seconds/);
    refuses((t) => (t.receivedAt = 0), "receivedAt is required");
    refuses((t) => (t.receivedAt = -5), "receivedAt is required");
  });
});

describe("prepareTask body size", () => {
  it("refuses a body over 64 KiB before sending it, as PayloadTooLargeError", () => {
    const task = good();
    task.mailFilters = Array.from({ length: 10 }, () => ({
      target: "from" as const,
      comparator: "includes" as const,
      value: "v".repeat(1024),
      orValues: Array.from({ length: 10 }, () => "o".repeat(1024)),
    }));
    assert.throws(
      () => prepare(task),
      (error: unknown) => {
        assert.ok(error instanceof PayloadTooLargeError);
        assert.equal(error.status, 413);
        return true;
      },
    );
  });
});

describe("the key never appears in a client-generated error", () => {
  it("redacts it from validation messages that echo a rejected value", () => {
    for (const edit of [
      (t: any) => (t.mailFilters[0].comparator = KEY),
      (t: any) => (t.mailFilters[0].target = `x${KEY}y`),
      (t: any) => (t.mailElements[0].target = KEY),
      (t: any) => (t.mailElements[0].formatter = KEY),
      (t: any) => (t.mailElements[0].regexSource = KEY),
    ]) {
      const task = good();
      edit(task);
      assert.throws(
        () => prepare(task),
        (error: unknown) => {
          assert.ok(error instanceof InvalidRequestError);
          assert.ok(!error.message.includes(KEY), error.message);
          assert.match(error.message, /\[redacted\]/);
          return true;
        },
      );
    }
  });

  it("redacts the JSON-escaped and URL-encoded forms too", () => {
    const tricky = 'abc"def\\ghi jkl/mno'; // needs JSON escaping and URL encoding
    const redactor = makeRedactor(tricky);
    for (const form of [tricky, JSON.stringify(tricky).slice(1, -1), encodeURIComponent(tricky)]) {
      assert.equal(redactor(`before ${form} after`), "before [redacted] after");
    }
  });

  it("leaves short secrets alone so ordinary words aren't mangled", () => {
    assert.equal(makeRedactor("abc")("abc def"), "abc def");
  });

  it("sanitizes foreign errors: no foreign objects, redacted messages, short chain", () => {
    const inner = Object.assign(new Error(`socket said ${KEY}`), { code: "ECONNRESET" });
    const outer = new TypeError(`fetch failed for ${KEY}`, { cause: inner });
    const clean = sanitizeCause(outer, redact) as Error & { cause: Error & { code: string } };
    assert.equal(clean.name, "TypeError");
    assert.ok(!clean.message.includes(KEY));
    assert.equal(clean.cause.code, "ECONNRESET");
    assert.ok(!clean.cause.message.includes(KEY));
    assert.notEqual(clean.cause, inner);
  });
});
