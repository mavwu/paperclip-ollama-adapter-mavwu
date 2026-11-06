import assert from "node:assert/strict";
import { test } from "node:test";
import { openDelegation } from "../dist/server/delegation.js";
import axios from "axios";
import http from "node:http";
import https from "node:https";
import { Writable, Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { execute } from "../dist/server/execute.js";
import { ACTION_DOCUMENT, RECEIPT_DOCUMENT } from "../dist/server/delegation.js";

const chat = content => ({ choices: [{ message: { content }, finish_reason: "stop" }] });
function context(overrides = {}) {
  return { runId: "run-a", agent: { id: "ceo", companyId: "company", name: "CEO", adapterType: "ollama_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "source" },
    config: { BASE_URL: "https://model.invalid/v1", PAPERCLIP_BASE_URL: "https://paperclip.invalid", API_KEY: "model-secret", MODEL: "test", DELEGATION_STORAGE: "paperclip_documents_v1" },
    context: { issueId: "source", prompt: "Delegate the review to CTO" }, authToken: "run-secret", onLog: async () => {}, ...overrides };
}
function world(t) {
  const previous = axios.defaults.adapter; t.after(() => { axios.defaults.adapter = previous; });
  for (const key of ["DELEGATION_STORAGE", "delegationStorage"]) {
    const value = process.env[key]; delete process.env[key];
    t.after(() => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  }
  const w = { calls: [], docs: new Map(), children: new Map(), source: { id: "source", companyId: "company", status: "in_progress", workMode: "standard", assigneeAgentId: "ceo", checkoutRunId: null, executionRunId: "run-a" },
    self: { id: "ceo", companyId: "company", status: "running" }, run: { status: "running", scopeKind: "issue", issueId: "source" },
    plan: { shouldDelegate: true, assigneeName: "CTO", title: "Review", description: "Review the design" }, hooks: {} };
  axios.defaults.adapter = async config => {
    const call = { url: config.url, method: config.method, headers: config.headers.toJSON(), signal: config.signal,
      body: typeof config.data === "string" ? JSON.parse(config.data) : config.data };
    w.calls.push(call);
    const path = new URL(config.url).pathname;
    const reply = (data, status = 200) => ({ config, status, headers: {}, data });
    const hook = await w.hooks.request?.(call); if (hook) return reply(hook.data, hook.status);
    if (path.endsWith("/agents/me")) return reply(w.self);
    if (path.includes("/heartbeat-runs/")) return reply({ id: w.source.executionRunId, companyId: "company", agentId: "ceo", ...w.run });
    if (path.endsWith("/chat/completions")) return reply(chat(JSON.stringify(w.plan)));
    if (path.endsWith("/agents")) return reply([{ id: "cto", name: "Alex", role: "cto", status: "idle" }]);
    if (path.includes("/documents/")) {
      const key = path.split("/").at(-1);
      if (call.method === "get") return reply(w.docs.get(key) ?? {}, w.docs.has(key) ? 200 : 404);
      await w.hooks.beforeDocument?.(key, call);
      if (w.docs.has(key)) return reply({}, 409);
      const data = { key, issueId: "source", companyId: "company", format: "markdown", body: call.body.body, latestRevisionId: "revision", lockedAt: null };
      w.docs.set(key, data);
      await w.hooks.afterDocument?.(key, data);
      return reply(data, 201);
    }
    if (call.method === "get") {
      const id = path.split("/").at(-1);
      return reply(id === "source" ? w.source : w.children.get(id) ?? {}, id === "source" || w.children.has(id) ? 200 : 404);
    }
    if (path.endsWith("/issues")) {
      const child = { ...call.body, id: "child", companyId: "company", identifier: "TASK-2" };
      w.children.set("child", child);
      await w.hooks.afterCreate?.(child);
      return reply(child, 201);
    }
    throw new Error("Unexpected route");
  };
  w.posts = () => w.calls.filter(c => c.method === "post" && c.url.endsWith("/issues"));
  return w;
}
function failed(result) { assert.equal(result.exitCode, 1); assert.equal(result.resultJson.success, false); assert.equal(result.resultJson.workflowCompleted, false); }

for (const differentRun of [false, true]) test(`orphan receipt blocks another creation across runs: ${differentRun}`, async t => {
  const w = world(t); assert.equal((await execute(context())).exitCode, 0);
  w.docs.delete(ACTION_DOCUMENT);
  const receipt = w.docs.get(RECEIPT_DOCUMENT).body, before = w.calls.length;
  // An expired server mapping and regenerated plan would otherwise create anew.
  w.plan.title = "Regenerated title after retention expired";
  w.hooks.request = c => {
    if (c.method === "post" && c.url.endsWith("/issues")) {
      const child = { ...c.body, id: "duplicate", companyId: "company" }; w.children.set(child.id, child);
      return { status: 201, data: child };
    }
  };
  if (differentRun) w.source.executionRunId = "run-b";
  const result = await execute(context({ runId: differentRun ? "run-b" : "run-a" })); failed(result);
  assert.equal(result.resultJson.actions.at(-1).reason, "orphan_receipt_requires_reconciliation");
  assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  assert.ok(w.calls.slice(before).every(c => c.method === "get"));
  assert.equal(w.posts().length, 1); assert.equal(w.children.size, 1);
  assert.equal(w.docs.has(ACTION_DOCUMENT), false); assert.equal(w.docs.get(RECEIPT_DOCUMENT).body, receipt);
});

function reusedResponse(w, fields = { deduplicated: true, deduplicationReason: "recent_open_title" }, status = 200) {
  w.hooks.request = c => {
    if (c.method === "post" && c.url.endsWith("/issues")) {
      const child = { ...c.body, id: "preexisting", companyId: "company", ...fields }; w.children.set(child.id, child);
      return { status, data: child };
    }
  };
}

for (const [name, change] of Object.entries({
  malformedBody: d => { d.body = "not JSON"; },
  objectID: d => { const v = JSON.parse(d.body); v.issueId = { "run-secret": "model-secret" }; d.body = JSON.stringify(v); },
  mismatchedScope: d => { d.companyId = "foreign"; },
  mismatchedKey: d => { const v = JSON.parse(d.body); v.actionKey = "foreign"; d.body = JSON.stringify(v); },
  invalidPayloadHash: d => { const v = JSON.parse(d.body); v.payloadHash = 2048; d.body = JSON.stringify(v); },
  invalidCreationMetadata: d => { const v = JSON.parse(d.body); v.creationOutcome = { "model-secret": "run-secret" }; d.body = JSON.stringify(v); },
})) test(`malformed orphan receipt blocks every mutation: ${name}`, async t => {
  const w = world(t); await execute(context()); w.docs.delete(ACTION_DOCUMENT); change(w.docs.get(RECEIPT_DOCUMENT));
  const before = w.calls.length, logs = [];
  const result = await execute(context({ onLog: async (_s, v) => logs.push(v) })); failed(result);
  assert.equal(result.resultJson.actions.at(-1).reason, "invalid_orphan_receipt");
  assert.ok(w.calls.slice(before).every(c => c.method === "get")); assert.equal(w.posts().length, 1);
  assert.ok(!/model-secret|run-secret/.test(JSON.stringify({ result, logs })));
});

for (const status of [401, 403, 500, 302]) test(`receipt existence read failure ${status} blocks fresh reservation`, async t => {
  const w = world(t); w.hooks.request = c => c.method === "get" && c.url.endsWith(RECEIPT_DOCUMENT) ? { status, data: {} } : undefined;
  failed(await execute(context())); assert.equal(w.docs.size, 0); assert.equal(w.posts().length, 0);
  assert.ok(w.calls.every(c => c.method === "get"));
});

test("receipt transport failure cannot be treated as an absent receipt", async t => {
  const w = world(t); w.hooks.request = c => { if (c.method === "get" && c.url.endsWith(RECEIPT_DOCUMENT)) throw new Error("Connection lost"); };
  failed(await execute(context())); assert.equal(w.docs.size, 0); assert.ok(w.calls.every(c => c.method === "get"));
});

test("conflicting receipt and reservation payloads never authorize another creation", async t => {
  const w = world(t); await execute(context()); const doc = w.docs.get(RECEIPT_DOCUMENT), body = JSON.parse(doc.body);
  body.payloadHash = "0".repeat(64); doc.body = JSON.stringify(body); const before = w.calls.length;
  failed(await execute(context())); assert.equal(w.posts().length, 1); assert.ok(w.calls.slice(before).every(c => c.method === "get"));
});

test("two verified absent documents retain the exclusive new-creation path", async t => {
  const w = world(t); const result = await execute(context()); assert.equal(result.exitCode, 0);
  const firstMutation = w.calls.findIndex(c => c.method === "put");
  for (const key of [ACTION_DOCUMENT, RECEIPT_DOCUMENT]) assert.ok(w.calls.slice(0, firstMutation).some(c => c.method === "get" && c.url.endsWith(key)));
  assert.equal(result.resultJson.actions.at(-1).creationOutcome, "created"); assert.match(result.summary, /^Created a follow-up task/);
  assert.equal(JSON.parse(w.docs.get(RECEIPT_DOCUMENT).body).creationOutcome, "created"); assert.equal(w.posts().length, 1);
});

for (const [name, fields, expected] of [
  ["missing metadata", {}, "unknown"], ["explicit false", { deduplicated: false }, "unknown"],
  ["reuse without diagnostic reason", { deduplicated: true }, "reused"],
  ["reuse with null diagnostic reason", { deduplicated: true, deduplicationReason: null }, "reused"],
]) test(`legacy/optional HTTP 200 metadata is handled conservatively: ${name}`, async t => {
  const w = world(t); reusedResponse(w, fields); const result = await execute(context()); assert.equal(result.exitCode, 0);
  assert.equal(result.resultJson.actions.at(-1).creationOutcome, expected); assert.doesNotMatch(result.summary, /^Created/);
  const receipt = JSON.parse(w.docs.get(RECEIPT_DOCUMENT).body); assert.equal(receipt.creationOutcome, expected); assert.equal(receipt.deduplicationReason, undefined);
});

for (const [name, fields, status] of [
  ["object flag", { deduplicated: { "run-secret": "model-secret" } }, 200],
  ["numeric flag", { deduplicated: 1 }, 200], ["string flag", { deduplicated: "true" }, 200],
  ["object reason", { deduplicated: true, deduplicationReason: { "model-secret": "run-secret" } }, 200],
  ["unknown reason", { deduplicated: true, deduplicationReason: "unknown" }, 200],
  ["reason without flag", { deduplicationReason: "idempotency_key" }, 200],
  ["reason with false flag", { deduplicated: false, deduplicationReason: "recent_open_title" }, 200],
  ["201 marked reused", { deduplicated: true, deduplicationReason: "idempotency_key" }, 201],
]) test(`malformed or contradictory creation diagnostics retain safe IDs without success: ${name}`, async t => {
  const w = world(t); reusedResponse(w, fields, status); const logs = [], meta = [];
  const result = await execute(context({ onLog: async (_s, v) => logs.push(v), onMeta: async v => meta.push(v) })); failed(result);
  const action = result.resultJson.actions.at(-1); assert.equal(action.issueId, "preexisting"); assert.equal(action.creationOutcome, "unknown");
  assert.equal(action.reason, "invalid_creation_metadata"); assert.equal(w.posts().length, 1);
  const receipt = JSON.parse(w.docs.get(RECEIPT_DOCUMENT).body); assert.equal(receipt.creationOutcome, "unknown"); assert.equal(receipt.deduplicationReason, undefined);
  assert.ok(!/model-secret|run-secret/.test(JSON.stringify({ result, logs, meta, receipt })));
});

for (const mode of ["cancel", "callback_failure"]) test(`verified reuse retains truthful receipts after ${mode}`, async t => {
  const w = world(t); reusedResponse(w, { deduplicated: true, deduplicationReason: "idempotency_key" });
  const controller = new AbortController();
  const result = await execute(context({ signal: controller.signal, onMeta: async () => {
    if (mode === "cancel") controller.abort(); else throw new Error("run-secret callback failure");
  } })); failed(result);
  const action = result.resultJson.actions.at(-1); assert.equal(action.creationOutcome, "reused"); assert.equal(action.issueId, "preexisting");
  assert.equal(action.persistence, "confirmed"); assert.equal(JSON.parse(w.docs.get(RECEIPT_DOCUMENT).body).creationOutcome, "reused");
  assert.equal(w.posts().length, 1);
});

test("cancellation immediately after reused response preserves its distinction without more requests", async t => {
  const w = world(t), controller = new AbortController();
  reusedResponse(w); const respond = w.hooks.request;
  w.hooks.request = c => { const reply = respond(c); if (reply) controller.abort(); return reply; };
  const result = await execute(context({ signal: controller.signal })); failed(result); assert.equal(result.errorCode, "cancelled");
  assert.equal(result.resultJson.actions.at(-1).creationOutcome, "reused"); assert.equal(result.resultJson.actions.at(-1).issueId, "preexisting");
  assert.ok(w.calls.at(-1).url.endsWith("/issues")); assert.equal(w.posts().length, 1);
});

test("legacy durable receipts reconcile without inventing creation or reuse metadata", async t => {
  const w = world(t); await execute(context()); const doc = w.docs.get(RECEIPT_DOCUMENT), body = JSON.parse(doc.body);
  delete body.creationOutcome; doc.body = JSON.stringify(body);
  const result = await execute(context()); assert.equal(result.exitCode, 0); assert.equal(result.resultJson.actions.at(-1).creationOutcome, "unknown");
  assert.equal(w.posts().length, 1);
});

test("cancellation during the new receipt-existence read prevents planning and mutations", async t => {
  const w = world(t), controller = new AbortController();
  w.hooks.request = c => {
    if (c.method === "get" && c.url.endsWith(RECEIPT_DOCUMENT)) { controller.abort("run-secret"); return { status: 404, data: {} }; }
  };
  const result = await execute(context({ signal: controller.signal })); failed(result); assert.equal(result.errorCode, "cancelled");
  assert.ok(w.calls.every(c => c.method === "get")); assert.equal(w.docs.size, 0); assert.equal(w.posts().length, 0);
});

test("malformed durable creation diagnostics cannot produce successful reconciliation", async t => {
  const w = world(t); reusedResponse(w); await execute(context());
  const doc = w.docs.get(RECEIPT_DOCUMENT), body = JSON.parse(doc.body); body.deduplicationReason = { "run-secret": "model-secret" }; doc.body = JSON.stringify(body);
  const before = w.calls.length, logs = []; const result = await execute(context({ onLog: async (_s, v) => logs.push(v) })); failed(result);
  assert.ok(w.calls.slice(before).every(c => c.method === "get")); assert.equal(w.posts().length, 1);
  assert.ok(!/run-secret|model-secret/.test(JSON.stringify({ result, logs })));
});

for (const reason of ["recent_open_title", "idempotency_key"]) test(`HTTP 200 reuse stays truthful and durable: ${reason}`, async t => {
  const w = world(t); reusedResponse(w, { deduplicated: true, deduplicationReason: reason });
  const logs = [], meta = []; const result = await execute(context({ onLog: async (_s, v) => logs.push(v), onMeta: async v => meta.push(v) }));
  assert.equal(result.exitCode, 0); assert.match(result.summary, /^Reused existing follow-up task/);
  const action = result.resultJson.actions.at(-1);
  assert.equal(action.creationOutcome, "reused"); assert.equal(action.deduplicationReason, reason); assert.equal(action.issueId, "preexisting");
  assert.equal(meta[0].context.actions.at(-1).creationOutcome, "reused"); assert.ok(logs.some(v => v.includes('"creationOutcome":"reused"')));
  const durable = JSON.parse(w.docs.get(RECEIPT_DOCUMENT).body);
  assert.equal(durable.creationOutcome, "reused"); assert.equal(durable.deduplicationReason, reason);
  const before = w.calls.length; const recovered = await execute(context());
  assert.equal(recovered.exitCode, 0); assert.equal(recovered.resultJson.actions.at(-1).creationOutcome, "reused");
  assert.equal(recovered.resultJson.actions.at(-1).deduplicationReason, reason);
  assert.equal(w.posts().length, 1); assert.ok(w.calls.slice(before).every(c => c.method === "get"));
});

test("delegation without durable storage fails closed before network activity", async () => {
  const result = await openDelegation({ storage: "disabled" }, {}, [], {});
  assert.equal(result.action.success, false);
  assert.equal(result.action.attempted, false);
  assert.equal(result.action.reason, "durable_storage_required");
});

test("confirmed action and immutable payload survive a new run without model or POST replay", async t => {
  const w = world(t);
  const first = await execute(context());
  assert.equal(first.exitCode, 0); assert.equal(w.posts().length, 1);
  assert.equal(w.docs.size, 2);
  const stored = JSON.parse(w.docs.get(ACTION_DOCUMENT).body);
  assert.equal(stored.payload.idempotencyKey, stored.actionKey);
  assert.equal(stored.payload.parentId, "source");
  const before = w.calls.length;
  w.source.executionRunId = "run-b"; w.plan.title = "Regenerated different title";
  const second = await execute(context({ runId: "run-b" }));
  assert.equal(second.exitCode, 0); assert.equal(second.resultJson.actions.at(-1).reconciled, true);
  assert.ok(w.calls.slice(before).every(c => c.method === "get"));
  assert.equal(w.posts().length, 1);
  assert.ok(!/model-secret|run-secret/.test([...w.docs.values()].map(d => d.body).join("")));
});

test("concurrent attempts reserve the unique action before sending a single creation", async t => {
  const w = world(t);
  const results = await Promise.all([execute(context()), execute(context())]);
  assert.equal(w.posts().length, 1);
  assert.equal(results.filter(r => r.exitCode === 0).length, 1);
});

test("lost creation response holds the durable reservation across a fresh process-equivalent run", async t => {
  const w = world(t); w.hooks.afterCreate = () => { throw new Error("Connection lost model-secret run-secret"); };
  const first = await execute(context()); failed(first);
  assert.equal(first.resultJson.actions.at(-1).persistence, "unknown"); assert.equal(w.children.size, 1);
  w.source.executionRunId = "run-b";
  const before = w.calls.length;
  const second = await execute(context({ runId: "run-b" })); failed(second);
  assert.equal(second.resultJson.actions.at(-1).reason, "unresolved_action");
  assert.ok(w.calls.slice(before).every(c => c.method === "get")); assert.equal(w.posts().length, 1);
  assert.ok(!/model-secret|run-secret/.test(JSON.stringify(first)));
});

test("expired unresolved records never authorize replay", async t => {
  const w = world(t); w.hooks.afterCreate = () => { throw new Error("Lost"); };
  await execute(context());
  const doc = w.docs.get(ACTION_DOCUMENT), body = JSON.parse(doc.body); body.createdAt = "2020-01-01T00:00:00.000Z"; doc.body = JSON.stringify(body);
  const result = await execute(context()); failed(result);
  assert.equal(result.resultJson.actions.at(-1).reason, "expired_unresolved_action"); assert.equal(w.posts().length, 1);
});

test("changed action request is held without regenerating or modifying the original payload", async t => {
  const w = world(t); await execute(context()); const body = w.docs.get(ACTION_DOCUMENT).body;
  const result = await execute(context({ context: { issueId: "source", prompt: "Delegate a different review to CTO" } })); failed(result);
  assert.equal(w.docs.get(ACTION_DOCUMENT).body, body); assert.equal(w.posts().length, 1);
});

for (const [name, fields] of Object.entries({ stale: { executionRunId: "old" }, conflicting: { checkoutRunId: "other" }, unowned: { assigneeAgentId: "other" }, closed: { status: "done" }, missingCheckout: { checkoutRunId: undefined }, wrongCompany: { companyId: "elsewhere" }, ask: { workMode: "ask" }, planning: { workMode: "planning" }, skillTest: { workMode: "skill_test" }, missingMode: { workMode: undefined } })) {
  test(`authoritative ownership rejects ${name} without model or mutation`, async t => {
    const w = world(t); Object.assign(w.source, fields);
    failed(await execute(context()));
    assert.equal(w.calls.length, 1); assert.ok(w.calls.every(c => c.method === "get"));
  });
}

for (const status of [403, 404, 405, 500]) {
  test(`unavailable document storage ${status} cannot lead to creation`, async t => {
    const w = world(t); w.hooks.request = c => c.url.includes("/documents/") && c.method === "put" ? { status, data: {} } : undefined;
    failed(await execute(context())); assert.equal(w.posts().length, 0);
  });
}

test("default storage policy and forged task configuration cannot enable delegation", async t => {
  const w = world(t), run = context(); delete run.config.DELEGATION_STORAGE;
  run.context.options = { DELEGATION_STORAGE: "paperclip_documents_v1", authToken: "attacker" };
  failed(await execute(run)); assert.equal(w.calls.length, 0);
});

test("cancellation after reservation prevents issue creation and blocks later replay", async t => {
  const w = world(t), controller = new AbortController();
  w.hooks.afterDocument = key => { if (key === ACTION_DOCUMENT) controller.abort("run-secret"); };
  const first = await execute(context({ signal: controller.signal })); failed(first); assert.equal(first.errorCode, "cancelled");
  assert.equal(w.posts().length, 0); assert.equal(w.docs.size, 1);
  w.hooks.afterDocument = undefined;
  failed(await execute(context())); assert.equal(w.posts().length, 0);
});

test("cancellation after a confirmed write preserves its receipt and starts no further request", async t => {
  const w = world(t), controller = new AbortController();
  w.hooks.afterCreate = () => controller.abort("private-reason");
  const result = await execute(context({ signal: controller.signal })); failed(result);
  assert.equal(result.errorCode, "cancelled"); assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  assert.equal(result.resultJson.actions.at(-1).persistence, "confirmed"); assert.ok(w.calls.at(-1).url.endsWith("/issues"));
  assert.equal(w.docs.has(RECEIPT_DOCUMENT), false);
});

test("ownership is rechecked after planning before reserving or creating", async t => {
  const w = world(t); w.hooks.request = c => { if (c.url.endsWith("/chat/completions")) w.source.executionRunId = "other"; };
  failed(await execute(context())); assert.equal(w.docs.size, 0); assert.equal(w.posts().length, 0);
});

test("redirected locked-document reservation is never treated as exclusive ownership", async t => {
  const w = world(t); w.hooks.afterDocument = (_key, doc) => { doc.key = "redirected-key"; };
  failed(await execute(context())); assert.equal(w.posts().length, 0);
});

test("reconciliation validates assignment and keeps known IDs on failure", async t => {
  const w = world(t); await execute(context()); w.children.get("child").assigneeAgentId = "other";
  const result = await execute(context()); failed(result);
  assert.equal(result.resultJson.actions.at(-1).issueId, "child"); assert.equal(result.resultJson.actions.at(-1).persistence, "unknown");
  assert.equal(w.posts().length, 1);
});

test("hostile receipt keys and values never enter logs or results", async t => {
  const w = world(t); await execute(context()); const doc = w.docs.get(RECEIPT_DOCUMENT);
  doc.body = JSON.stringify({ version: 1, actionKey: "wrong", issueId: { "run-secret": "model-secret" }, "model-secret": "run-secret" });
  const logs = []; const result = await execute(context({ onLog: async (_s, v) => logs.push(v) })); failed(result);
  assert.ok(!/run-secret|model-secret/.test(JSON.stringify({ result, logs }))); assert.equal(w.posts().length, 1);
});

test("model and Paperclip credentials and run attribution stay separated for all journal paths", async t => {
  const w = world(t); assert.equal((await execute(context())).exitCode, 0);
  for (const c of w.calls) {
    const model = c.url.startsWith("https://model.invalid");
    assert.equal(c.headers.Authorization, model ? "Bearer model-secret" : "Bearer run-secret");
    assert.equal(c.headers["X-Paperclip-Run-Id"], model ? undefined : "run-a");
    if (c.body && !model) assert.ok(!/model-secret|run-secret/.test(JSON.stringify(c.body)));
  }
  assert.ok(w.calls.every(c => !["patch", "delete"].includes(c.method)));
});

for (const [name, update] of Object.entries({
  terminatedRun: w => { w.run.status = "cancelled"; },
  differentRunTask: w => { w.run.issueId = "other"; },
  companyScopedRun: w => { w.run.scopeKind = "company"; },
  wrongRunIdentity: w => { w.run.agentId = "other"; },
  foreignAgent: w => { w.self.companyId = "other"; },
  wrongAgent: w => { w.self.id = "other"; },
  pausedAgent: w => { w.self.status = "paused"; },
  scopedToken: w => { w.self.keyScope = { kind: "skill_test", issueId: "source" }; },
})) {
  test(`authoritative run and agent validation rejects ${name}`, async t => {
    const w = world(t); update(w); failed(await execute(context()));
    assert.ok(w.calls.every(c => c.method === "get")); assert.equal(w.docs.size, 0);
  });
}

test("a confirmed receipt remains usable after the server idempotency retention window", async t => {
  const w = world(t); await execute(context());
  const doc = w.docs.get(ACTION_DOCUMENT), body = JSON.parse(doc.body); body.createdAt = "2020-01-01T00:00:00.000Z"; doc.body = JSON.stringify(body);
  assert.equal((await execute(context())).exitCode, 0); assert.equal(w.posts().length, 1);
});

test("foreign-company safety documents cannot be reused", async t => {
  const w = world(t); await execute(context()); w.docs.get(ACTION_DOCUMENT).companyId = "foreign";
  failed(await execute(context())); assert.equal(w.posts().length, 1);
});

test("a separate Node process reconciles durable receipts without generating or posting an action", async t => {
  const w = world(t); assert.equal((await execute(context())).exitCode, 0);
  const snapshot = { docs: [...w.docs], child: w.children.get("child"), source: { ...w.source, executionRunId: "run-b" }, run: context({ runId: "run-b" }) };
  const script = `
    import fs from 'node:fs'; import axios from 'axios'; import { execute } from './dist/server/execute.js';
    const state=JSON.parse(fs.readFileSync(0,'utf8')); const docs=new Map(state.docs); let writes=0, model=0;
    axios.defaults.adapter=async config=>{
      const path=new URL(config.url).pathname; let data;
      if(config.method!=='get'){ writes++; throw new Error('Recovery must be read-only'); }
      if(path.endsWith('/chat/completions')){ model++; throw new Error('No inference during reconciliation'); }
      if(path.endsWith('/agents/me')) data={id:'ceo',companyId:'company',status:'running'};
      else if(path.includes('/heartbeat-runs/')) data={id:'run-b',companyId:'company',agentId:'ceo',status:'running',scopeKind:'issue',issueId:'source'};
      else if(path.includes('/documents/')) data=docs.get(path.split('/').at(-1));
      else data=path.endsWith('/source')?state.source:state.child;
      return {config,status:data?200:404,headers:{},data:data??{}};
    };
    state.run.onLog=async()=>{}; const result=await execute(state.run);
    console.log(JSON.stringify({exitCode:result.exitCode,reconciled:result.resultJson.actions.at(-1).reconciled,writes,model}));
  `;
  const processResult = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), input: JSON.stringify(snapshot), encoding: "utf8", timeout: 15_000 });
  assert.equal(processResult.status, 0, processResult.stderr || processResult.error?.message);
  assert.deepEqual(JSON.parse(processResult.stdout), { exitCode: 0, reconciled: true, writes: 0, model: 0 });
});

test("otherwise valid stored receipts discard hostile extra keys and values", async t => {
  const w = world(t); await execute(context()); const doc = w.docs.get(RECEIPT_DOCUMENT);
  doc.body = JSON.stringify({ ...JSON.parse(doc.body), "run-secret": { "model-secret": "run-secret" }, arbitrary: ["model-secret"] });
  const logs = []; const result = await execute(context({ onLog: async (_s, value) => logs.push(value) }));
  assert.equal(result.exitCode, 0); assert.ok(!/run-secret|model-secret/.test(JSON.stringify({ result, logs })));
  assert.equal(w.posts().length, 1);
});

test("changed stored payload cannot be reused or replace its original action", async t => {
  const w = world(t); await execute(context());
  const doc = w.docs.get(ACTION_DOCUMENT), body = JSON.parse(doc.body); body.payload.title = "Changed"; doc.body = JSON.stringify(body);
  failed(await execute(context())); assert.equal(w.posts().length, 1);
});

test("callback failure after durable confirmation preserves the receipt for recovery", async t => {
  const w = world(t);
  const result = await execute(context({ onMeta: async () => { throw new Error("run-secret metadata failure"); } })); failed(result);
  assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  assert.equal(w.docs.has(RECEIPT_DOCUMENT), true);
  assert.equal((await execute(context())).exitCode, 0); assert.equal(w.posts().length, 1);
});

test("uncertain reservation persistence cannot authorize creation or a replacement reservation", async t => {
  const w = world(t); w.hooks.afterDocument = key => { if (key === ACTION_DOCUMENT) throw new Error("Lost document response"); };
  failed(await execute(context())); assert.equal(w.posts().length, 0);
  w.hooks.afterDocument = undefined;
  failed(await execute(context())); assert.equal(w.posts().length, 0);
});

test("lost durable receipt response can be reconciled by authenticated reads", async t => {
  const w = world(t); w.hooks.afterDocument = key => { if (key === RECEIPT_DOCUMENT) throw new Error("Lost receipt response"); };
  const result = await execute(context()); failed(result); assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  w.hooks.afterDocument = undefined;
  assert.equal((await execute(context())).exitCode, 0); assert.equal(w.posts().length, 1);
});

test("known issue disappearance never authorizes new creation", async t => {
  const w = world(t); await execute(context()); w.children.clear();
  const result = await execute(context()); failed(result); assert.equal(result.resultJson.actions.at(-1).issueId, "child"); assert.equal(w.posts().length, 1);
});

test("credentials in planner payloads never enter persistent documents", async t => {
  const w = world(t); w.plan.description = "Echo model-secret run-secret";
  failed(await execute(context())); assert.equal(w.docs.size, 0); assert.equal(w.posts().length, 0);
});

test("missing authentication prevents all ownership and journal requests", async t => {
  const w = world(t); const run = context(); delete run.authToken;
  failed(await execute(run)); assert.equal(w.calls.length, 0);
});

test("pre-cancellation prevents all journal and inference activity", async t => {
  const w = world(t), controller = new AbortController(); controller.abort();
  const result = await execute(context({ signal: controller.signal })); failed(result); assert.equal(result.errorCode, "cancelled"); assert.equal(w.calls.length, 0);
});

test("storage aliases obey trusted precedence and reject invalid values before requests", async t => {
  const w = world(t), run = context();
  run.config.DELEGATION_STORAGE = "invalid"; run.config.delegationStorage = "paperclip_documents_v1";
  const result = await execute(run); failed(result); assert.equal(result.errorCode, "INVALID_CONFIGURATION"); assert.equal(w.calls.length, 0);
});

test("status-only recovery permits receipt reconciliation but no new action or journal mutation", async t => {
  const w = world(t);
  w.run.contextSnapshot = { recoveryIntent: "status_only", allowDeliverableWork: false, allowDocumentUpdates: false, resumeRequiresNormalModel: true };
  const restricted = await execute(context()); failed(restricted);
  assert.equal(restricted.resultJson.actions.at(-1).reason, "recovery_mutation_forbidden");
  assert.ok(w.calls.every(c => c.method === "get"));
  w.run.contextSnapshot = {}; assert.equal((await execute(context())).exitCode, 0);
  const before = w.calls.length;
  w.run.contextSnapshot = { recoveryIntent: "status_only", allowDeliverableWork: false, allowDocumentUpdates: false, resumeRequiresNormalModel: true };
  assert.equal((await execute(context())).exitCode, 0);
  assert.ok(w.calls.slice(before).every(c => c.method === "get")); assert.equal(w.posts().length, 1);
});

test("ownership lost after reservation prevents creation without acquiring a checkout", async t => {
  const w = world(t); w.hooks.afterDocument = key => { if (key === ACTION_DOCUMENT) w.source.checkoutRunId = "other"; };
  failed(await execute(context())); assert.equal(w.posts().length, 0); assert.equal(w.docs.size, 1);
});

test("receipt cancellation preserves confirmed creation and can later reconcile stored evidence", async t => {
  const w = world(t), controller = new AbortController();
  w.hooks.afterDocument = key => { if (key === RECEIPT_DOCUMENT) controller.abort(); };
  const result = await execute(context({ signal: controller.signal })); failed(result); assert.equal(result.errorCode, "cancelled");
  assert.equal(result.resultJson.actions.at(-1).issueId, "child"); assert.equal(result.resultJson.actions.at(-1).persistence, "confirmed");
  assert.ok(w.calls.at(-1).url.endsWith(RECEIPT_DOCUMENT));
  w.hooks.afterDocument = undefined;
  assert.equal((await execute(context())).exitCode, 0); assert.equal(w.posts().length, 1);
});

for (const stop of ["PAPERCLIP_REQUEST_TIMEOUT", "EXECUTION_DEADLINE_EXCEEDED"]) {
  test(`journal reservation honors ${stop} without issue creation`, async t => {
    try { t.mock.timers.enable({ apis: ["setTimeout"] }); }
    catch { t.skip(`Timer mocking unsupported on ${process.version}; journal deadline scheduling unverified`); return; }
    const w = world(t); let started;
    const ready = new Promise(resolve => { started = resolve; });
    w.hooks.request = c => c.method === "put" ? new Promise((_resolve, reject) => {
      c.signal.addEventListener("abort", () => reject(new axios.CanceledError("Aborted")), { once: true }); started();
    }) : undefined;
    const run = context(); run.config[stop === "PAPERCLIP_REQUEST_TIMEOUT" ? "PAPERCLIP_REQUEST_TIMEOUT_MS" : "EXECUTION_TIMEOUT_MS"] = 25;
    const pending = execute(run); await ready; t.mock.timers.tick(25);
    const result = await pending; failed(result); assert.equal(result.errorCode, stop); assert.equal(result.timedOut, true); assert.equal(w.posts().length, 0);
  });
}

for (const mode of ["complete", "cancel_journal"]) test(`real Axios ownership/journal requests use private agents: ${mode}`, async t => {
  const w = world(t), server = axios.defaults.adapter;
  const originalHttp = http.request, originalHttps = https.request;
  t.after(() => { http.request = originalHttp; https.request = originalHttps; });
  const native = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const intercepted = (options, callback) => {
    let body = "";
    const req = new Writable({ autoDestroy: false, write(chunk, _encoding, done) { body += chunk.toString(); done(); }, final(done) {
      done();
      if (mode === "cancel_journal" && options.method === "PUT") { started(req); return; }
      const config = { method: options.method.toLowerCase(), url: `${options.protocol}//${options.hostname}${options.path}`, headers: new axios.AxiosHeaders(options.headers), data: body || undefined };
      Promise.resolve(server(config)).then(reply => {
        if (req.destroyed) return;
        const response = Readable.from([JSON.stringify(reply.data)]); response.statusCode = reply.status;
        response.headers = { "content-type": "application/json" }; response.req = req; callback(response);
      }, error => req.destroy(error));
    } });
    req.setTimeout = () => req; req.setKeepAlive = () => req;
    native.push({ options, req }); return req;
  };
  http.request = intercepted; https.request = intercepted; axios.defaults.adapter = "http";
  const controller = new AbortController();
  const pending = execute(context({ signal: controller.signal }));
  if (mode === "cancel_journal") {
    const request = await ready; assert.equal(request.destroyed, false); controller.abort();
    const result = await pending; failed(result); assert.equal(result.errorCode, "cancelled"); assert.equal(request.destroyed, true);
    assert.equal(w.posts().length, 0); assert.equal(native.at(-1).options.method, "PUT"); return;
  }
  const result = await pending; assert.equal(result.exitCode, 0);
  assert.equal(native.length, w.calls.length);
  assert.ok(native.some(c => c.options.method === "PUT"));
  assert.ok(native.every(c => c.options.agent !== https.globalAgent && c.options.agent.options.rejectUnauthorized === true));
  for (const { options } of native) {
    const model = options.hostname === "model.invalid";
    assert.equal(options.headers.Authorization, model ? "Bearer model-secret" : "Bearer run-secret");
    assert.equal(options.headers["X-Paperclip-Run-Id"], model ? undefined : "run-a");
  }
  assert.equal(w.posts().length, 1);
});
