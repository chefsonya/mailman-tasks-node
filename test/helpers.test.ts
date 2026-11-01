import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codeTask, InvalidRequestError, linkTask } from "../src/index.js";
import { makeRedactor } from "../src/redact.js";
import { prepareTask } from "../src/validate.js";

const prepare = (task: Parameters<typeof prepareTask>[0]) =>
  prepareTask(task, { defaultGroup: "default", nowSeconds: 1_793_145_600, redact: makeRedactor("irrelevant-key") });

describe("codeTask", () => {
  it("has the shape of the guide's examples", () => {
    assert.deepEqual(codeTask({ email: "alias@example.com", from: "noreply@example.com", subjectIncludes: "verification code" }), {
      email: "alias@example.com",
      mailFilters: [
        { target: "from", comparator: "includes", value: "noreply@example.com" },
        { target: "subject", comparator: "includes", value: "verification code" },
      ],
      mailElements: [{ name: "code", target: "body", regex: "\\b\\d{6}\\b" }],
    });
  });

  it("escapes the regular expression for JSON (rule M12)", () => {
    const json = JSON.stringify(codeTask({ email: "a@b.c", from: "x", subjectIncludes: "y" }));
    // On the wire the backslashes are doubled: "\\b\\d{6}\\b". A single \b in JSON is a backspace.
    assert.ok(json.includes('"regex":"\\\\b\\\\d{6}\\\\b"'), json);
    assert.ok(!json.includes("\b"), "no backspace character");
    const sent = JSON.parse(json).mailElements[0].regex as string;
    assert.equal(sent, String.raw`\b\d{6}\b`);
  });

  it("the regular expression finds a standalone code of the right length", () => {
    const { regex } = codeTask({ email: "a@b.c", from: "x", subjectIncludes: "y", length: 4 }).mailElements[0]!;
    const re = new RegExp(regex!);
    assert.equal(re.exec("Your code is 4821.")?.[0], "4821");
    assert.equal(re.exec("order 12345 shipped"), null);
    assert.equal(re.exec("pin: 123"), null);
    assert.equal(new RegExp(codeTask({ email: "a@b.c", from: "x", subjectIncludes: "y" }).mailElements[0]!.regex!).exec("code 123456!")?.[0], "123456");
  });

  it("refuses a code length that isn't 1 to 32", () => {
    for (const length of [0, 33, 1.5, Number.NaN, -1]) {
      assert.throws(() => codeTask({ email: "a@b.c", from: "x", subjectIncludes: "y", length }), InvalidRequestError);
    }
    codeTask({ email: "a@b.c", from: "x", subjectIncludes: "y", length: 1 });
    codeTask({ email: "a@b.c", from: "x", subjectIncludes: "y", length: 32 });
  });

  it("passes timeout, group, receivedAt and templateId through, and produces a task the API accepts", () => {
    const task = codeTask({ email: "a@b.c", from: "x", subjectIncludes: "y", timeout: 90, group: "g", receivedAt: 1_700_000_000, templateId: "t" });
    assert.deepEqual([task.timeout, task.group, task.receivedAt, task.templateId], [90, "g", 1_700_000_000, "t"]);
    prepare(task);
  });
});

describe("linkTask", () => {
  it("has the shape of the guide's link example", () => {
    assert.deepEqual(linkTask({ email: "a@b.c", from: "noreply@example.com", subjectIncludes: "Sign in", linkIncludes: "/login" }), {
      email: "a@b.c",
      mailFilters: [
        { target: "from", comparator: "includes", value: "noreply@example.com" },
        { target: "subject", comparator: "includes", value: "Sign in" },
      ],
      mailElements: [{ name: "loginUrl", target: "body", selector: "a[href*='/login']", formatter: "link" }],
    });
  });

  it("escapes quotes, backslashes and line breaks in the selector", () => {
    const selector = (linkIncludes: string) =>
      linkTask({ email: "a@b.c", from: "x", subjectIncludes: "y", linkIncludes }).mailElements[0]!.selector;
    assert.equal(selector("it's"), String.raw`a[href*='it\'s']`);
    assert.equal(selector(String.raw`a\b`), String.raw`a[href*='a\\b']`);
    assert.equal(selector("a\nb"), "a[href*='a\\a b']");
    // A closing bracket or quote can't end the selector early.
    assert.equal(selector("']; x['"), String.raw`a[href*='\']; x[\'']`);
  });

  it("requires linkIncludes, and produces a task the API accepts", () => {
    assert.throws(() => linkTask({ email: "a@b.c", from: "x", subjectIncludes: "y", linkIncludes: "" }), InvalidRequestError);
    prepare(linkTask({ email: "a@b.c", from: "x", subjectIncludes: "y", linkIncludes: "/verify" }));
  });
});
