import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import axios from "axios";
import { execute } from "../dist/server/execute.js";
import { readOllamaConfig } from "../dist/server/config.js";
import { testEnvironment } from "../dist/server/test.js";
import http from "node:http";
import https from "node:https";
import { Writable, Readable } from "node:stream";
import { performance } from "node:perf_hooks";

const originalAdapter = axios.defaults.adapter;
const originalHttp = http.request, originalHttps = https.request;
const timeoutKeys = ["MODEL_REQUEST_TIMEOUT_MS", "modelRequestTimeoutMs", "PAPERCLIP_REQUEST_TIMEOUT_MS", "paperclipRequestTimeoutMs", "EXECUTION_TIMEOUT_MS", "executionTimeoutMs", "TIMEOUT_SEC", "timeoutSec"];
let savedTimeoutEnv;
let calls, respond;
const chat = content => ({ choices: [{ message: { content }, finish_reason: "stop" }] });
const agents = [{ id: "cto", name: "Alex", role: "cto", status: "idle" }];
const plan = chat('{"shouldDelegate":true,"assigneeName":"CTO","title":"Review","description":"Review"}');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function enableTimers(t) {
  try { t.mock.timers.enable({ apis: ["setTimeout"] }); return true; }
  catch { t.skip(`Compatible Node timer mocking is unavailable on ${process.version}; deterministic deadline scheduling is unverified`); return false; }
}
function run(config = {}, prompt = "Explain addition") {
  return { runId: "lifecycle-run", agent: { id: "ceo", companyId: "company", name: "CEO", adapterType: "ollama_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue" },
    config: { BASE_URL: "https://model.invalid/v1", PAPERCLIP_BASE_URL: "https://paperclip.invalid", API_KEY: "model-secret", MODEL: "test-model", MODEL_REQUEST_TIMEOUT_MS: 1000, PAPERCLIP_REQUEST_TIMEOUT_MS: 500, EXECUTION_TIMEOUT_MS: 5000, ...config },
    context: { prompt, issueId: "issue" }, authToken: "run-secret", onLog: async () => {} };
}
beforeEach(() => {
  savedTimeoutEnv = Object.fromEntries(timeoutKeys.map(key => [key, process.env[key]]));
  for (const key of timeoutKeys) delete process.env[key];
  calls = [];
  respond = () => chat("Answer");
  axios.defaults.adapter = async config => {
    calls.push(config);
    const data = await respond(config);
    return { status: 200, statusText: "OK", headers: {}, config, data };
  };
});
afterEach(() => {
  axios.defaults.adapter = originalAdapter; http.request = originalHttp; https.request = originalHttps;
  for (const key of timeoutKeys) { if (savedTimeoutEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedTimeoutEnv[key]; }
});
function delegation(write = () => ({ id: "child", assigneeAgentId: "cto", identifier: "TEST-2" })) {
  respond = config => config.method === "get" ? agents : config.url.endsWith("/issues") ? write(config) : plan;
}
function stalled(config, started) {
  started.resolve(config);
  return new Promise((_yes, no) => {
    const abort = () => no(new axios.CanceledError("Synthetic transport cancellation"));
    if (config.signal?.aborted) abort(); else config.signal?.addEventListener("abort", abort, { once: true });
  });
}
function stopped(result, code) {
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorCode, code);
  assert.equal(result.resultJson.success, false);
  assert.equal(result.resultJson.workflowCompleted, false);
  assert.equal(result.timedOut, code !== "cancelled" && code.endsWith("TIMEOUT") || code === "EXECUTION_DEADLINE_EXCEEDED");
  assert.ok(calls.every(call => call.method !== "patch"));
  assert.equal(result.errorFamily, undefined);
  assert.equal(result.retryNotBefore, undefined);
}

test("already cancelled host signal prevents all requests and does not leak abort reasons", async () => {
  const controller = new AbortController(); controller.abort(new Error("private-abort-reason"));
  const result = await execute({ ...run(), signal: controller.signal });
  stopped(result, "cancelled"); assert.equal(calls.length, 0);
  assert.equal(result.resultJson.status, "cancelled");
  assert.ok(!JSON.stringify(result).includes("private-abort-reason"));
});

test("cancellation readiness and metadata precede exactly one dispatch notification", async () => {
  const order = [], controller = new AbortController();
  const ctx = { ...run(), signal: controller.signal, onCancellationReady: async () => { order.push("ready"); }, onDispatch: () => { order.push("dispatch"); }, onMeta: async () => { order.push("meta"); } };
  respond = config => { order.push("request"); assert.ok(config.signal); return chat("Answer"); };
  assert.equal((await execute(ctx)).exitCode, 0);
  assert.deepEqual(order, ["ready", "meta", "dispatch", "request"]);
});

test("readiness callback cancellation prevents dispatch", async () => {
  const controller = new AbortController(); let dispatched = false;
  const result = await execute({ ...run(), signal: controller.signal, onCancellationReady: async () => controller.abort(), onDispatch: () => { dispatched = true; } });
  stopped(result, "cancelled"); assert.equal(dispatched, false); assert.equal(calls.length, 0);
});

for (const callback of ["onCancellationReady", "onDispatch"]) {
  test(`${callback} failure prevents network dispatch`, async () => {
    const controller = new AbortController();
    const result = await execute({ ...run(), signal: controller.signal, [callback]: () => { throw new Error("callback secret=opaque-value"); } });
    stopped(result, "ADAPTER_LIFECYCLE_FAILED"); assert.equal(calls.length, 0);
    assert.ok(!JSON.stringify(result).includes("opaque-value"));
  });
}

test("dispatch callback cancellation is rechecked before the request", async () => {
  const controller = new AbortController();
  const result = await execute({ ...run(), signal: controller.signal, onDispatch: () => controller.abort() });
  stopped(result, "cancelled"); assert.equal(calls.length, 0);
});

test("cancellation aborts in-flight inference and does not become a successful response", async () => {
  const started = deferred(), controller = new AbortController(); respond = config => stalled(config, started);
  const pending = execute({ ...run(), signal: controller.signal });
  const config = await started.promise; controller.abort();
  stopped(await pending, "cancelled"); assert.equal(config.signal.aborted, true); assert.equal(calls.length, 1);
});

test("cancellation during the planner prevents delegation writes", async () => {
  const controller = new AbortController();
  delegation(); const base = respond;
  respond = config => { const data = base(config); if (config.url.endsWith("/chat/completions")) controller.abort(); return data; };
  const result = await execute({ ...run({}, "Delegate to CTO"), signal: controller.signal });
  stopped(result, "cancelled"); assert.equal(calls.length, 2); assert.ok(calls.every(c => !c.url.endsWith("/issues")));
});

test("cancellation during issue creation preserves an uncertain write and never retries", async () => {
  const started = deferred(), controller = new AbortController(); delegation(config => stalled(config, started));
  const pending = execute({ ...run({}, "Delegate to CTO"), signal: controller.signal });
  await started.promise; controller.abort(); const result = await pending;
  stopped(result, "cancelled");
  assert.equal(result.resultJson.actions.at(-1).persistence, "unknown");
  assert.equal(result.resultJson.actions.at(-1).attempted, true);
  assert.equal(result.resultJson.actions.at(-1).success, false);
  assert.match(result.summary, /may have persisted/i);
  assert.equal(calls.filter(c => c.url.endsWith("/issues")).length, 1);
});

test("cancellation after an acknowledged write retains the verified receipt", async () => {
  const controller = new AbortController(); delegation();
  const result = await execute({ ...run({}, "Delegate to CTO"), signal: controller.signal, onMeta: async () => controller.abort() });
  stopped(result, "cancelled");
  assert.equal(result.resultJson.actions.at(-1).persistence, "confirmed");
  assert.equal(result.resultJson.actions.at(-1).success, true);
  assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  assert.equal(calls.length, 3);
});

test("a received receipt survives Axios's post-response cancellation check", async () => {
  const controller = new AbortController(); delegation(() => { queueMicrotask(() => controller.abort()); return { id: "child", assigneeAgentId: "cto" }; });
  const result = await execute({ ...run({}, "Delegate to CTO"), signal: controller.signal });
  stopped(result, "cancelled"); assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  assert.equal(result.resultJson.actions.at(-1).persistence, "confirmed");
});

test("a write receipt received at request timeout retains its ID but the run is timed out", async t => {
  if (!enableTimers(t)) return;
  delegation(() => { t.mock.timers.tick(25); return { id: "child", assigneeAgentId: "cto" }; });
  const result = await execute(run({ PAPERCLIP_REQUEST_TIMEOUT_MS: 25 }, "Delegate to CTO"));
  stopped(result, "PAPERCLIP_REQUEST_TIMEOUT");
  assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  assert.equal(result.resultJson.actions.at(-1).persistence, "confirmed");
});

test("cancellation arriving during error logging remains cancellation", async () => {
  const controller = new AbortController(); respond = () => { throw new Error("network failure"); };
  const result = await execute({ ...run(), signal: controller.signal, onLog: async () => controller.abort() });
  stopped(result, "cancelled");
});

test("the overall budget is shared by lookup and planning", async t => {
  if (!enableTimers(t)) return; const started = deferred();
  respond = config => { if (config.method === "get") { t.mock.timers.tick(10); return agents; } return stalled(config, started); };
  const pending = execute(run({ EXECUTION_TIMEOUT_MS: 25 }, "Delegate to CTO"));
  await started.promise; t.mock.timers.tick(15);
  stopped(await pending, "EXECUTION_DEADLINE_EXCEEDED"); assert.equal(calls.length, 2);
});

test("overall timeout after a confirmed write preserves the receipt", async t => {
  if (!enableTimers(t)) return; delegation();
  const result = await execute({ ...run({ EXECUTION_TIMEOUT_MS: 25 }, "Delegate to CTO"), onMeta: async () => { t.mock.timers.tick(25); } });
  stopped(result, "EXECUTION_DEADLINE_EXCEEDED"); assert.equal(result.resultJson.actions.at(-1).issueId, "child");
});

for (const mode of ["ask", "planning", "skill_test", "unknown"]) {
  test(`${mode} work-mode context cannot create delegation writes`, async () => {
    const ctx = run({}, "Delegate to CTO"); ctx.context.paperclipIssue = { id: "issue", workMode: mode };
    const result = await execute(ctx);
    assert.equal(result.errorCode, "PAPERCLIP_WORK_MODE_UNSUPPORTED"); assert.equal(calls.length, 0);
  });
}

for (const target of ["model", "paperclip"]) {
  for (const stop of ["cancel", "request_timeout"]) {
    test(`native Axios abort destroys the ${target} request on ${stop}`, async t => {
      if (!enableTimers(t)) return;
      axios.defaults.adapter = "http"; const started = deferred(), controller = new AbortController();
      const requests = [];
      const nativeRequest = options => {
        const req = new Writable({ autoDestroy: false, write(_data, _encoding, done) { done(); } });
        req.setTimeout = () => req; req.setKeepAlive = () => req;
        requests.push({ req, options }); started.resolve(); return req;
      };
      http.request = nativeRequest; https.request = nativeRequest;
      const ctx = { ...run({ MODEL_REQUEST_TIMEOUT_MS: 25, PAPERCLIP_REQUEST_TIMEOUT_MS: 25 }, target === "model" ? "Explain addition" : "Who are our agents?"), signal: controller.signal };
      const pending = execute(ctx); await started.promise;
      assert.equal(requests[0].req.destroyed, false);
      if (stop === "cancel") controller.abort(); else t.mock.timers.tick(25);
      const result = await pending;
      stopped(result, stop === "cancel" ? "cancelled" : target === "model" ? "MODEL_REQUEST_TIMEOUT" : "PAPERCLIP_REQUEST_TIMEOUT");
      assert.equal(requests.length, 1); assert.equal(requests[0].req.destroyed, true);
      assert.equal(requests[0].options.headers.Authorization, target === "model" ? "Bearer model-secret" : "Bearer run-secret");
      assert.equal(requests[0].options.agent.options.rejectUnauthorized, true);
    });
  }
}

for (const stop of ["cancel", "timeout"]) {
  test(`native Axios ${stop} during POST is uncertain and never replayed`, async t => {
    if (!enableTimers(t)) return; axios.defaults.adapter = "http";
    const started = deferred(), controller = new AbortController(), requests = [];
    const nativeRequest = (options, callback) => {
      const req = new Writable({ autoDestroy: false, write(_c, _e, done) { done(); }, final(done) {
        done();
        if (options.path.endsWith("/issues")) { started.resolve(req); return; }
        queueMicrotask(() => {
          const response = Readable.from([JSON.stringify(options.method === "GET" ? agents : plan)]);
          response.statusCode = 200; response.headers = { "content-type": "application/json" }; response.req = req; callback(response);
        });
      } });
      req.setTimeout = () => req; req.setKeepAlive = () => req; requests.push({ options, req }); return req;
    };
    http.request = nativeRequest; https.request = nativeRequest;
    const pending = execute({ ...run({ PAPERCLIP_REQUEST_TIMEOUT_MS: 25 }, "Delegate to CTO"), signal: controller.signal });
    const post = await started.promise; assert.equal(post.destroyed, false);
    if (stop === "cancel") controller.abort(); else t.mock.timers.tick(25);
    const result = await pending;
    stopped(result, stop === "cancel" ? "cancelled" : "PAPERCLIP_REQUEST_TIMEOUT");
    assert.equal(post.destroyed, true);
    assert.equal(result.resultJson.actions.at(-1).persistence, "unknown");
    assert.equal(requests.filter(request => request.options.path.endsWith("/issues")).length, 1);
    assert.match(result.summary, /may have persisted/i);
  });
}

for (const [field, code, prompt] of [["MODEL_REQUEST_TIMEOUT_MS", "MODEL_REQUEST_TIMEOUT", "Explain addition"], ["EXECUTION_TIMEOUT_MS", "EXECUTION_DEADLINE_EXCEEDED", "Explain addition"], ["PAPERCLIP_REQUEST_TIMEOUT_MS", "PAPERCLIP_REQUEST_TIMEOUT", "Who are our agents?"]]) {
  test(`${field} aborts stalled requests with distinct timeout reporting`, async t => {
    if (!enableTimers(t)) return;
    const started = deferred(); respond = config => stalled(config, started);
    const pending = execute(run({ [field]: 25 }, prompt));
    const request = await started.promise; t.mock.timers.tick(25);
    stopped(await pending, code); assert.equal(request.signal.aborted, true); assert.equal(calls.length, 1);
  });
}

test("optional company request timeout remains nonfatal to inference", async t => {
  if (!enableTimers(t)) return; const started = deferred();
  respond = config => config.method === "get" ? stalled(config, started) : chat("General advice");
  const pending = execute(run({ PAPERCLIP_REQUEST_TIMEOUT_MS: 25 }, "Suggest a workflow for our team"));
  await started.promise; t.mock.timers.tick(25); const result = await pending;
  assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false);
  assert.equal(result.resultJson.actions[0].errorCode, "PAPERCLIP_REQUEST_TIMEOUT");
  assert.equal(result.resultJson.actions[0].required, false); assert.equal(calls.length, 2);
});

test("overall deadline bounds additional work after a slow readiness callback settles", async t => {
  if (!enableTimers(t)) return; const ready = deferred(), finish = deferred();
  const ctx = { ...run({ EXECUTION_TIMEOUT_MS: 25 }), signal: new AbortController().signal, onCancellationReady: async () => { ready.resolve(); await finish.promise; } };
  const pending = execute(ctx); await ready.promise; t.mock.timers.tick(25); finish.resolve();
  stopped(await pending, "EXECUTION_DEADLINE_EXCEEDED"); assert.equal(calls.length, 0);
});

for (const failure of [new Error("socket hang up"), { message: "Service error", response: { status: 503, data: { error: "Unavailable" } } }, { message: "Denied", response: { status: 403, data: { error: "Forbidden" } } }]) {
  test(`write outcome is explicit for ${failure.response?.status ?? "transport failure"}`, async () => {
    delegation(() => { throw failure; }); const result = await execute(run({}, "Delegate to CTO"));
    assert.equal(result.exitCode, 1);
    assert.equal(result.resultJson.actions.at(-1).persistence, failure.response?.status === 403 ? "rejected" : "unknown");
    assert.equal(calls.filter(c => c.url.endsWith("/issues")).length, 1);
  });
}

for (const field of ["MODEL_REQUEST_TIMEOUT_MS", "PAPERCLIP_REQUEST_TIMEOUT_MS", "EXECUTION_TIMEOUT_MS"]) {
  for (const value of [0, -1, 1.5, "", "bad", null, 86400001]) {
    test(`invalid ${field}: ${JSON.stringify(value)} fails before dispatch`, async () => {
      const result = await execute(run({ [field]: value })); assert.equal(result.errorCode, "INVALID_CONFIGURATION"); assert.equal(calls.length, 0);
    });
  }
}

test("timeout aliases follow trusted configuration precedence and task overrides stay blocked", async () => {
  const config = readOllamaConfig({ modelRequestTimeoutMs: 100, env: { MODEL_REQUEST_TIMEOUT_MS: "200" } }, [{ MODEL_REQUEST_TIMEOUT_MS: 1, timeoutSec: 0, signal: new AbortController().signal }]);
  assert.equal(config.modelRequestTimeoutMs, 100);
  assert.equal(config.executionTimeoutMs, 300000);
});

test("the official timeoutSec setting caps the overall budget but cannot disable its bound", async () => {
  assert.equal(readOllamaConfig({ timeoutSec: 2 }).executionTimeoutMs, 2000);
  assert.equal(readOllamaConfig({ timeoutSec: 0 }).executionTimeoutMs, 300000);
});

test("already cancelled executions remain cancelled even with invalid configuration", async () => {
  const controller = new AbortController(); controller.abort();
  stopped(await execute({ ...run({ MODEL_REQUEST_TIMEOUT_MS: 0 }), signal: controller.signal }), "cancelled");
  assert.equal(calls.length, 0);
});

test("multi-request delegation registers and dispatches exactly once", async () => {
  delegation(); const order = [], controller = new AbortController(), base = respond;
  respond = config => { order.push(config.method === "get" ? "lookup" : config.url.endsWith("/issues") ? "write" : "planner"); return base(config); };
  const result = await execute({ ...run({}, "Delegate to CTO"), signal: controller.signal,
    onCancellationReady: async () => { order.push("ready"); }, onDispatch: () => { order.push("dispatch"); }, onMeta: async () => { order.push("meta"); } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(order, ["ready", "dispatch", "lookup", "planner", "write", "meta"]);
});

test("host cancellation reasons cannot impersonate request timeouts", async () => {
  const controller = new AbortController(), started = deferred(); respond = config => stalled(config, started);
  const pending = execute({ ...run(), signal: controller.signal }); await started.promise;
  controller.abort(new Error("MODEL_REQUEST_TIMEOUT private host detail"));
  const result = await pending; stopped(result, "cancelled"); assert.ok(!JSON.stringify(result).includes("private host detail"));
});

test("callback and deadline cleanup removes host listeners and request timers", async t => {
  if (!enableTimers(t)) return; const controller = new AbortController();
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  let added = 0, removed = 0;
  controller.signal.addEventListener = (...args) => { added++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
  const result = await execute({ ...run(), signal: controller.signal });
  assert.equal(result.exitCode, 0); assert.equal(added, 1); assert.equal(removed, 1);
  controller.abort(); t.mock.timers.tick(10000);
  assert.equal(calls[0].signal.aborted, false); assert.equal(calls.length, 1);
});

test("task options cannot replace lifecycle channels or timeout budgets", async () => {
  const controller = new AbortController(); controller.abort(); const ctx = run();
  ctx.context.options = { signal: controller.signal, MODEL_REQUEST_TIMEOUT_MS: 0, PAPERCLIP_REQUEST_TIMEOUT_MS: 0, EXECUTION_TIMEOUT_MS: 0, timeoutSec: 0.001,
    onDispatch: () => { throw new Error("untrusted dispatch"); }, onCancellationReady: () => { throw new Error("untrusted readiness"); } };
  assert.equal((await execute(ctx)).exitCode, 0); assert.equal(calls.length, 1);
});

for (const field of ["modelRequestTimeoutMs", "paperclipRequestTimeoutMs", "executionTimeoutMs"]) {
  const upper = field.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  test(`${field} precedence normalizes aliases at every trusted layer`, () => {
    process.env[upper] = "400";
    assert.equal(readOllamaConfig({ [field]: 100, env: { [upper]: "200" } })[field], 100);
    assert.equal(readOllamaConfig({ env: { [field]: "200" } })[field], 200);
    assert.equal(readOllamaConfig({ [upper]: 100, [field]: 200 })[field], 100);
    assert.equal(readOllamaConfig()[field], 400);
  });
}

for (const value of [-1, null, "bad", 86401, 0.0001]) {
  test(`invalid official timeoutSec cap ${JSON.stringify(value)} fails before requests`, async () => {
    const result = await execute(run({ timeoutSec: value })); assert.equal(result.errorCode, "INVALID_CONFIGURATION"); assert.equal(calls.length, 0);
  });
}

for (const [status, persistence] of [[408, "unknown"], [499, "unknown"], [429, "rejected"], [500, "unknown"], [302, "unknown"]]) {
  test(`HTTP ${status} write reports ${persistence} without replay`, async () => {
    delegation(() => { throw { message: "Synthetic response", response: { status, data: { error: "Service response" } } }; });
    const result = await execute(run({}, "Delegate to CTO")); assert.equal(result.exitCode, 1);
    assert.equal(result.resultJson.actions.at(-1).persistence, persistence);
    assert.equal(calls.filter(call => call.url.endsWith("/issues")).length, 1);
    if (persistence === "unknown") assert.match(result.summary, /may have persisted/i);
  });
}

test("environment probe honors the shorter configured request budget", async t => {
  if (!enableTimers(t)) return; const started = deferred(); respond = config => stalled(config, started);
  const pending = testEnvironment({ companyId: "company", adapterType: "ollama_local", config: run({ MODEL_REQUEST_TIMEOUT_MS: 25 }).config });
  await started.promise; t.mock.timers.tick(25); const result = await pending;
  assert.equal(result.status, "fail"); assert.match(result.checks.at(-1).detail, /exceeded its deadline/);
});

for (const fields of [{ onCancellationReady: async () => {} }, { signal: null }, { signal: { aborted: false } }, { onDispatch: async () => {} }]) {
  test(`unsupported host lifecycle fields fail without requests: ${Object.keys(fields).join(",")}`, async () => {
    const result = await execute({ ...run(), ...fields }); stopped(result, "ADAPTER_LIFECYCLE_FAILED"); assert.equal(calls.length, 0);
  });
}

for (const target of ["model", "write"]) {
  test(`monotonic ${target} deadline is enforced even before its timer callback runs`, async t => {
    let now = 0;
    try { t.mock.method(performance, "now", () => now); }
    catch { t.skip(`Monotonic clock mocking is unavailable on ${process.version}; this scheduling edge is unverified`); return; }
    if (target === "model") respond = () => { now = 30; return chat("Late answer"); };
    else delegation(() => { now = 30; return { id: "child", assigneeAgentId: "cto" }; });
    const result = await execute(run({ MODEL_REQUEST_TIMEOUT_MS: target === "model" ? 25 : 1000, PAPERCLIP_REQUEST_TIMEOUT_MS: target === "write" ? 25 : 500 }, target === "model" ? "Explain addition" : "Delegate to CTO"));
    stopped(result, target === "model" ? "MODEL_REQUEST_TIMEOUT" : "PAPERCLIP_REQUEST_TIMEOUT");
    if (target === "write") assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  });
}
