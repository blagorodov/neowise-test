import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

let server;
let base;

// Start the real HTTP server on an available local port.
before(async () => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT: String(port) } });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Server did not start");
});

// Stop the server after exercising its HTTP contract.
after(() => server?.kill());

// Reject malformed and empty input without calling the model.
test("invalid input", async () => {
  for (const body of ["{", "null", "{}", '{"text":null}', '{"text":42}', '{"text":""}', '{"text":"   "}']) {
    const response = await fetch(`${base}/api/triage`, { method: "POST", body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "invalid_input" });
  }
});

// Return the validated topic and draft for a normal request.
test("valid result", async () => {
  const response = await fetch(`${base}/api/triage`, { method: "POST", body: JSON.stringify({ text: "доставка" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready", topic: "delivery", draft: "Спасибо за обращение. Уточним детали заявки." });
});

// Fall back for each simulator failure, including a bounded timeout.
test("model failures", async () => {
  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    const start = performance.now();
    const response = await fetch(`${base}/api/triage`, { method: "POST", body: JSON.stringify({ text: marker }) });
    assert.equal(response.status, 200, marker);
    assert.deepEqual(await response.json(), { status: "manual_review", topic: null, draft: null }, marker);
    if (marker === "[timeout]") assert.ok(performance.now() - start < 600, "timeout must stay close to the 300 ms limit");
  }
});

// Ignore older responses when requests finish in a different order.
test("page ignores stale responses", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  for (const [older, newer, expected] of [
    [{ status: "ready", topic: "other", draft: "old draft" }, { status: "manual_review" }, /вручную/],
    [{ status: "manual_review" }, { status: "ready", topic: "pricing", draft: "new draft" }, /new draft/],
  ]) {
    const result = { textContent: "" };
    const input = { value: "request" };
    let submit;
    const form = { addEventListener: (_, handler) => { submit = handler; } };
    const document = { querySelector: (selector) => ({ form, "#result": result, "#message": input })[selector] };
    const pending = [];
    runInNewContext(script, { document, fetch: () => new Promise((resolve) => pending.push(resolve)) });
    const first = submit({ preventDefault() {} });
    const second = submit({ preventDefault() {} });
    pending[1]({ json: async () => newer });
    await second;
    pending[0]({ json: async () => older });
    await first;
    assert.match(result.textContent, expected);
    assert.doesNotMatch(result.textContent, /old draft/);
  }
});

// Replace a previously displayed draft when the next request needs manual review.
test("page clears previous draft", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const input = { value: "доставка" };
  const result = { textContent: "" };
  let submit;
  const form = { addEventListener: (_, handler) => { submit = handler; } };
  const document = { querySelector: (selector) => ({ form, "#result": result, "#message": input })[selector] };
  runInNewContext(script, { document, fetch: (path, options) => fetch(`${base}${path}`, options) });
  await submit({ preventDefault() {} });
  assert.match(result.textContent, /Черновик: Спасибо/);
  input.value = "[error]";
  await submit({ preventDefault() {} });
  assert.match(result.textContent, /вручную/);
  assert.doesNotMatch(result.textContent, /Спасибо/);
});
