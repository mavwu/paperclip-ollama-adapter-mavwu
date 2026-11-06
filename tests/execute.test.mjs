import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import axios from "axios";
import { execute, extractPrompt, wantsCompanyContext, wantsDelegation } from "../dist/server/execute.js";
import { readOllamaConfig } from "../dist/server/config.js";
import { testEnvironment } from "../dist/server/test.js";
import * as entry from "../dist/index.js";

const originalTransport = axios.defaults.adapter;
let calls;
let respond;
beforeEach(() => {
  calls = [];
  respond = () => { throw new Error("Unexpected request; network disabled in tests"); };
  // All adapter HTTP requests use this in-memory transport; no real services are contacted.
  axios.defaults.adapter = async config => {
    const call = {
      method: config.method, url: config.url,
      data: typeof config.data === "string" ? JSON.parse(config.data) : config.data,
      headers: config.headers.toJSON(),
    };
    calls.push(call);
    return { status: 200, statusText: "OK", headers: {}, config, data: await respond(call) };
  };
});
afterEach(() => { axios.defaults.adapter = originalTransport; });

const chat = (content, finish_reason = "stop") => ({
  choices: [{ message: { content }, finish_reason }],
  usage: { prompt_tokens: 10, completion_tokens: 12 },
});
const agent = (overrides = {}) => ({ id: "cto", name: "Alex", role: "cto", title: "Chief Technology Officer", status: "idle", ...overrides });
const plan = (overrides = {}) => chat(JSON.stringify({
  shouldDelegate: true, assigneeName: "CTO", title: "Review design", description: "Review the design", ...overrides,
}));
function context(prompt = "Explain addition", config = {}, wake = {}) {
  return {
    runId: "test-run",
    agent: { id: "ceo", companyId: "test-company", name: "CEO", adapterType: "ollama_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "test-issue" },
    config: {
      BASE_URL: "http://model.invalid/v1", PAPERCLIP_BASE_URL: "http://paperclip.invalid",
      API_KEY: "fake-model-key", MODEL: "test-model", SYSTEM_PROMPT: "Test instructions",
      AUTO_MARK_DONE: false, ENABLE_PAPERCLIP_ACTIONS: true, ...config,
    },
    context: { issueId: "test-issue", prompt, ...wake }, authToken: "fake-run-token", onLog: async () => {},
  };
}
function delegateTransport(agents = [agent()], decision = plan(), created = { id: "child", identifier: "TEST-2" }) {
  respond = call => {
    if (call.method === "get") return agents;
    if (call.url.endsWith("/chat/completions")) return decision;
    if (call.method === "post" && call.url.endsWith("/issues")) return created;
    throw new Error("Unexpected mutation");
  };
}
function noCompletionWrites() { assert.equal(calls.some(c => c.method === "patch"), false); }
function noIssueCreation() { assert.equal(calls.some(c => c.method === "post" && c.url.endsWith("/issues")), false); }
function failed(result, code) {
  assert.equal(result.exitCode, 1);
  assert.equal(result.resultJson.success, false);
  assert.equal(result.resultJson.workflowCompleted, false);
  assert.equal(result.resultJson.stopReason, "failed");
  if (code) assert.equal(result.errorCode, code);
  noCompletionWrites();
}

test("automatic completion defaults off in configuration and schema", async () => {
  const previous = process.env.AUTO_MARK_DONE;
  const camel = process.env.autoMarkDone;
  try {
    delete process.env.AUTO_MARK_DONE; delete process.env.autoMarkDone;
    assert.equal(readOllamaConfig().autoMarkDone, false);
  } finally {
    if (previous === undefined) delete process.env.AUTO_MARK_DONE; else process.env.AUTO_MARK_DONE = previous;
    if (camel === undefined) delete process.env.autoMarkDone; else process.env.autoMarkDone = camel;
  }
  const schema = await entry.createServerAdapter().getConfigSchema();
  assert.equal(schema.fields.find(f => f.key === "AUTO_MARK_DONE").default, false);
});

test("working text inference retains request settings and usage without claiming task completion", async () => {
  respond = () => chat("Two numbers can be added.");
  const result = await execute(context("Explain addition", { TEMPERATURE: 0.2, MAX_TOKENS: 100 }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, "Two numbers can be added.");
  assert.equal(result.resultJson.success, true);
  assert.equal(result.resultJson.stopReason, "response_received");
  assert.equal(result.resultJson.workflowCompleted, false);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 12 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.model, "test-model");
  assert.equal(calls[0].data.temperature, 0.2);
  assert.equal(calls[0].data.max_tokens, 100);
  assert.equal(calls[0].data.messages[0].content, "Test instructions");
  noCompletionWrites();
});

for (const reply of ["Here is the finished answer.", "I am blocked and cannot do this.", "I will investigate next."]) {
  test(`legacy completion opt-in cannot close unverified work: ${reply}`, async () => {
    respond = () => chat(reply);
    const result = await execute(context("Do the work", { AUTO_MARK_DONE: true }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.resultJson.workflowCompleted, false);
    assert.equal(result.resultJson.disposition.reason, "completion_not_verified");
    noCompletionWrites();
  });
}

const invalidResponses = [
  ["empty object", {}, "OLLAMA_EMPTY_RESPONSE"],
  ["blank content", chat("  "), "OLLAMA_EMPTY_RESPONSE"],
  ["reasoning only", { choices: [{ message: { reasoning_content: "Private reasoning" }, finish_reason: "stop" }] }, "OLLAMA_EMPTY_RESPONSE"],
  ["truncated", chat("Partial answer", "length"), "OLLAMA_TRUNCATED_RESPONSE"],
  ["filtered", chat("Filtered answer", "content_filter"), "OLLAMA_INCOMPLETE_RESPONSE"],
  ["unknown finish reason", chat("Some answer", "unknown"), "OLLAMA_INCOMPLETE_RESPONSE"],
  ["nonterminal finish reason", chat("Partial answer", null), "OLLAMA_INCOMPLETE_RESPONSE"],
  ["refusal", { choices: [{ message: { content: "Cannot help", refusal: "Refused" }, finish_reason: "stop" }] }, "OLLAMA_REFUSAL"],
  ["tool calls", { choices: [{ message: { content: "Calling tool", tool_calls: [{ id: "call-1" }] }, finish_reason: "tool_calls" }] }, "OLLAMA_UNSUPPORTED_TOOL_CALL"],
  ["native tool calls", { message: { content: "", tool_calls: [{ function: { name: "create_task" } }] } }, "OLLAMA_UNSUPPORTED_TOOL_CALL"],
  ["legacy function call", { choices: [{ message: { content: null, function_call: { name: "create_task" } }, finish_reason: "function_call" }] }, "OLLAMA_UNSUPPORTED_TOOL_CALL"],
  ["native incomplete", { response: "Partial", done: false }, "OLLAMA_INCOMPLETE_RESPONSE"],
  ["native truncated", { response: "Partial", done: true, done_reason: "length" }, "OLLAMA_TRUNCATED_RESPONSE"],
];
for (const [name, payload, code] of invalidResponses) {
  test(`invalid inference fails safely: ${name}`, async () => {
    respond = () => payload;
    failed(await execute(context("Do the work", { AUTO_MARK_DONE: true })), code);
    assert.equal(calls.length, 1);
  });
}

for (const [name, payload] of [
  ["legacy completion", { choices: [{ text: "Legacy answer", finish_reason: "stop" }] }],
  ["native chat", { message: { content: "Native answer" }, done: true }],
  ["native generate", { response: "Generated answer", done: true }],
  ["compatible endpoint without finish reason", { choices: [{ message: { content: "Compatible answer" } }] }],
]) {
  test(`usable text formats remain supported: ${name}`, async () => {
    respond = () => payload;
    const result = await execute(context());
    assert.equal(result.exitCode, 0);
    assert.ok(result.summary);
    noCompletionWrites();
  });
}

test("denied delegation fails the run and never closes the source", async () => {
  delegateTransport();
  const inner = respond;
  respond = call => {
    if (call.url.endsWith("/issues")) throw new axios.AxiosError("Forbidden", "ERR_BAD_REQUEST", undefined, undefined, { status: 403, data: { error: "not authorized" } });
    return inner(call);
  };
  const result = await execute(context("Tell CTO to review this", { AUTO_MARK_DONE: true }));
  failed(result, "PAPERCLIP_DELEGATION_FAILED");
  assert.equal(result.resultJson.actions.at(-1).success, false);
  assert.equal(result.resultJson.actions.at(-1).status, 403);
  assert.match(result.summary, /not authorized/);
});

test("successful delegation reports the persisted issue without completing parent", async () => {
  delegateTransport();
  const result = await execute(context("Tell CTO to review this", { AUTO_MARK_DONE: true }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.resultJson.stopReason, "delegated");
  assert.equal(result.resultJson.workflowCompleted, false);
  assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  const created = calls.find(c => c.url.endsWith("/issues"));
  assert.deepEqual(created.data, { title: "Review design", description: "Review the design", status: "todo", parentId: "test-issue", assigneeAgentId: "cto" });
  noCompletionWrites();
});

test("task creation without a receipt is not claimed successful or retried", async () => {
  delegateTransport([agent()], plan(), {});
  const result = await execute(context("Delegate to CTO"));
  failed(result, "PAPERCLIP_DELEGATION_FAILED");
  assert.equal(result.resultJson.actions.at(-1).reason, "invalid_issue_receipt");
  assert.equal(calls.filter(c => c.url.endsWith("/issues")).length, 1);
});

test("a receipt assigned to a different agent cannot claim the requested handoff succeeded", async () => {
  delegateTransport([agent()], plan(), { id: "existing-child", assigneeAgentId: "someone-else" });
  const result = await execute(context("Delegate to CTO"));
  failed(result, "PAPERCLIP_DELEGATION_FAILED");
  assert.equal(result.resultJson.actions.at(-1).reason, "assignment_not_verified");
  assert.equal(result.resultJson.actions.at(-1).issueId, "existing-child");
});

test("post-creation logging failure retains the action receipt and reports execution failure", async () => {
  delegateTransport();
  const run = context("Delegate to CTO");
  run.onLog = async () => { throw new Error("Log storage unavailable"); };
  const result = await execute(run);
  failed(result, "ADAPTER_EXECUTION_FAILED");
  assert.equal(result.resultJson.actions.at(-1).success, true);
  assert.equal(result.resultJson.actions.at(-1).issueId, "child");
  assert.equal(calls.filter(c => c.url.endsWith("/issues")).length, 1);
});

for (const [name, decision] of [
  ["malformed JSON", chat("not JSON")],
  ["missing boolean", chat('{"assigneeName":"CTO"}')],
  ["string boolean", plan({ shouldDelegate: "true" })],
  ["invalid name type", plan({ assigneeName: { name: "CTO" } })],
  ["truncated plan", { ...plan(), choices: [{ message: { content: '{"shouldDelegate":true}' }, finish_reason: "length" }] }],
]) {
  test(`planner failure does not silently fall back to successful chat: ${name}`, async () => {
    delegateTransport([agent()], decision);
    failed(await execute(context("Delegate to CTO")), "PAPERCLIP_DELEGATION_FAILED");
    noIssueCreation();
    assert.equal(calls.filter(c => c.url.endsWith("/chat/completions")).length, 1);
  });
}

test("planner declining an explicit delegation is recorded as an unperformed action", async () => {
  delegateTransport([agent()], plan({ shouldDelegate: false }));
  const result = await execute(context("Delegate to CTO"));
  failed(result, "PAPERCLIP_DELEGATION_FAILED");
  assert.equal(result.resultJson.actions.at(-1).reason, "delegation_declined");
  noIssueCreation();
});

for (const [name, agents, assignee, reason] of [
  ["ambiguous role", [agent(), agent({ id: "other", name: "Morgan" })], "CTO", "assignee_ambiguous"],
  ["duplicate exact name", [agent(), agent({ id: "other" })], "Alex", "assignee_ambiguous"],
  ["substring", [agent()], "Alexandra", "assignee_not_found"],
  ["missing agent", [agent()], "Developer", "assignee_not_found"],
  ["self assignment", [agent({ id: "ceo" })], "CTO", "assignee_ineligible"],
  ...["paused", "terminated", "pending_approval", "error", "unknown", null].map(status => [String(status), [agent({ status })], "CTO", "assignee_ineligible"]),
]) {
  test(`unsafe assignment is rejected: ${name}`, async () => {
    delegateTransport(agents, plan({ assigneeName: assignee }));
    const result = await execute(context("Delegate to CTO"));
    failed(result, "PAPERCLIP_DELEGATION_FAILED");
    assert.equal(result.resultJson.actions.at(-1).reason, reason);
    noIssueCreation();
  });
}

for (const status of ["idle", "active", "running"]) {
  test(`eligible assignee state is accepted: ${status}`, async () => {
    delegateTransport([agent({ status })]);
    assert.equal((await execute(context("Delegate to CTO"))).exitCode, 0);
    assert.equal(calls.filter(c => c.url.endsWith("/issues")).length, 1);
  });
}

test("exact named assignee takes precedence over other agents sharing a role", async () => {
  delegateTransport([agent({ name: "CTO" }), agent({ id: "other", name: "Morgan" })]);
  assert.equal((await execute(context("Delegate to CTO"))).exitCode, 0);
  assert.equal(calls.find(c => c.url.endsWith("/issues")).data.assigneeAgentId, "cto");
});

test("company information never activates planner from injected handoff instructions", async () => {
  respond = call => call.method === "get" ? [agent()] : chat("Alex is our CTO.");
  assert.equal(wantsDelegation("Who are our agents?"), false);
  const result = await execute(context("Who are our agents?"));
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].data.messages[0].content, "Test instructions");
  noIssueCreation();
});

test("wake comment intent is independent of historical delegation text", async () => {
  respond = () => chat("Current answer");
  const result = await execute(context("Delegate to CTO", {}, {
    paperclipWakeComment: { body: "Explain the current design" }, paperclipTaskMarkdown: "Old task: tell CTO to review this",
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].data.messages[1].content.includes("Old task:"));
});

test("explicit current prompt takes precedence over issue text for action detection", async () => {
  respond = () => chat("Current answer");
  const result = await execute(context("Explain the current design", {}, { paperclipIssue: { id: "test-issue", description: "Tell CTO to review this" } }));
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  noIssueCreation();
});

test("planner receives original request, not injected context or historical instructions", async () => {
  delegateTransport();
  await execute(context("Tell CTO to review this", {}, {
    paperclipWakeComment: { body: "Tell CTO to review this" }, paperclipTaskMarkdown: "HISTORICAL_SENTINEL",
  }));
  const planner = calls.find(c => c.url.endsWith("/chat/completions"));
  assert.ok(planner.data.messages[1].content.includes("Tell CTO to review this"));
  assert.ok(!planner.data.messages[1].content.includes("HISTORICAL_SENTINEL"));
  assert.ok(!planner.data.messages[1].content.includes("If you create or claim"));
});

for (const [name, agents] of [["empty list", []], ["invalid agent response", {}]]) {
  test(`missing delegation candidates fail explicitly: ${name}`, async () => {
    delegateTransport(agents);
    failed(await execute(context("Delegate to CTO")), "PAPERCLIP_DELEGATION_FAILED");
    noIssueCreation();
  });
}

test("agent lookup denial cannot become a successful company action", async () => {
  respond = () => { throw new Error("Lookup denied"); };
  const result = await execute(context("Who are our agents?"));
  failed(result, "PAPERCLIP_CONTEXT_FAILED");
  assert.equal(result.resultJson.actions[0].success, false);
  assert.equal(calls.length, 1);
});

test("actions disabled preserves chat without any Paperclip calls", async () => {
  respond = () => chat("A general workflow suggestion.");
  assert.equal((await execute(context("Suggest a workflow for our team", { ENABLE_PAPERCLIP_ACTIONS: false }))).exitCode, 0);
  assert.ok(calls.every(c => c.url.startsWith("http://model.invalid")));
});

for (const prompt of [
  "Explain how a JavaScript agent works", "What is a company?", "Compare AI agents and tools",
  "Explain team collaboration", "What is an org chart?", "Design a multi-agent system", "Define organization",
]) {
  test(`generic text requires no company lookup or token: ${prompt}`, async () => {
    respond = () => chat("General knowledge answer");
    const run = context(prompt);
    delete run.authToken;
    const result = await execute(run);
    assert.equal(wantsCompanyContext(prompt), false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.resultJson.stopReason, "response_received");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith("http://model.invalid"));
    noIssueCreation(); noCompletionWrites();
  });
}

test("generic agent terminology does not request company data even with a token", async () => {
  respond = () => chat("General answer");
  assert.equal((await execute(context("Explain how an AI agent works"))).exitCode, 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("http://model.invalid"));
});

for (const missingToken of [false, true]) {
  test(`optional company enrichment can fail without failing inference (missing token: ${missingToken})`, async () => {
    respond = call => {
      if (call.method === "get") throw new Error("Optional lookup unavailable");
      return chat("A general workflow suggestion; company data was unavailable.");
    };
    const run = context("Suggest a workflow for our team", { AUTO_MARK_DONE: true });
    if (missingToken) delete run.authToken;
    const result = await execute(run);
    assert.equal(result.exitCode, 0);
    assert.equal(result.resultJson.success, true);
    assert.equal(result.resultJson.stopReason, "response_received");
    assert.equal(result.resultJson.workflowCompleted, false);
    assert.equal(result.resultJson.actions[0].success, false);
    assert.equal(result.resultJson.actions[0].required, false);
    assert.equal(calls.filter(c => c.url.endsWith("/chat/completions")).length, 1);
    if (missingToken) assert.equal(calls.length, 1);
    noIssueCreation(); noCompletionWrites();
  });
}

test("optional enrichment succeeds without invoking delegation planning", async () => {
  respond = call => call.method === "get" ? [agent()] : chat("General workflow suggestion");
  assert.equal((await execute(context("Suggest a workflow for our team"))).exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].data.messages[0].content, "Test instructions");
  noIssueCreation();
});

for (const prompt of [
  "Who are our agents?", "List company agents", "Show our org chart", "Who reports to CTO?",
  "Use authenticated Paperclip data to identify our CTO", "What is our company budget?", "Tell CTO to review this",
  "Who is our CTO?", "Show the team roster", "What are the available agents?",
]) {
  test(`authenticated organizational request fails without token: ${prompt}`, async () => {
    const run = context(prompt);
    delete run.authToken;
    failed(await execute(run), wantsDelegation(prompt) ? "PAPERCLIP_DELEGATION_FAILED" : "PAPERCLIP_CONTEXT_FAILED");
    assert.equal(calls.length, 0);
  });
}

for (const prompt of ["List our agents", "Delegate to CTO"]) {
  test(`disabled organizational operations cannot be simulated by chat: ${prompt}`, async () => {
    failed(await execute(context(prompt, { ENABLE_PAPERCLIP_ACTIONS: false })), "PAPERCLIP_ACTIONS_DISABLED");
    assert.equal(calls.length, 0);
  });
}

function providerFailure(data, message = "Request failed with status code 404", status = 404) {
  return new axios.AxiosError(message, "ERR_BAD_REQUEST", undefined, undefined, { status, data });
}

for (const [format, data] of [
  ["OpenAI error.message", { error: { message: "Requested model is not installed" } }],
  ["Ollama error", { error: "Requested model is not installed" }],
  ["message", { message: "Requested model is not installed" }],
  ["detail", { detail: "Requested model is not installed" }],
  ["plain text", "Requested model is not installed"],
  ["JSON text", '{"error":{"message":"Requested model is not installed"}}'],
]) {
  test(`provider error retains safe detail and status: ${format}`, async () => {
    respond = () => { throw providerFailure(data); };
    const result = await execute(context());
    failed(result, "OLLAMA_ERROR_404");
    assert.match(result.errorMessage, /HTTP 404/);
    assert.match(result.errorMessage, /Requested model is not installed/);
    assert.ok(result.errorMessage.length <= 512);
  });
}

for (const [format, data] of [
  ["null", null], ["array", [{ secret: "never-serialize-array" }]],
  ["unexpected object", { nested: { secret: "never-serialize-object" } }],
  ["invalid message type", { error: { message: { toString() { throw new Error("must-not-coerce"); } } } }],
  ["broken JSON", '{"error":not-json}'],
]) {
  test(`malformed error body uses a safe fallback: ${format}`, async () => {
    respond = () => { throw providerFailure(data); };
    const result = await execute(context());
    failed(result, "OLLAMA_ERROR_404");
    assert.match(result.errorMessage, /HTTP 404/);
    assert.ok(!/never-serialize|must-not-coerce|not-json|\[object Object\]/.test(JSON.stringify(result)));
  });
}

test("provider errors redact known secrets, sensitive fields, headers and URLs on every diagnostic surface", async () => {
  const previous = process.env.REVIEW_INTERNAL_SECRET;
  process.env.REVIEW_INTERNAL_SECRET = "internal-secret-sentinel";
  const secrets = ["fake-model-key", "fake-run-token", "internal-secret-sentinel", "header-sentinel", "cookie-sentinel", "url-sentinel", "json-token-sentinel"];
  const logs = [];
  try {
    respond = () => { throw providerFailure({ error: { message: [
      "Requested model is not installed", ...secrets.slice(0, 3),
      "Authorization: Bearer header-sentinel", "Cookie: session=cookie-sentinel",
      "https://user:url-sentinel@provider.invalid/error?access_token=url-sentinel",
      '"access_token":"json-token-sentinel"',
    ].join("\n") }, headers: { "x-secret": "never-copy-response-headers" }, stack: "never-copy-stack" }); };
    const run = context();
    run.onLog = async (_stream, text) => logs.push(text);
    const result = await execute(run);
    failed(result, "OLLAMA_ERROR_404");
    assert.match(result.errorMessage, /Requested model is not installed/);
    const diagnostic = JSON.stringify({ result, logs });
    for (const secret of [...secrets, "never-copy-response-headers", "never-copy-stack"]) assert.ok(!diagnostic.includes(secret), `Leaked synthetic secret: ${secret}`);
    assert.ok(result.errorMessage.length <= 512);
    assert.match(diagnostic, /REDACTED/);
  } finally {
    if (previous === undefined) delete process.env.REVIEW_INTERNAL_SECRET; else process.env.REVIEW_INTERNAL_SECRET = previous;
  }
});

for (const [kind, text] of [
  ["HTML", '<html><script>unsafe-script-sentinel</script>unsafe-content-sentinel</html>'],
  ["ANSI", '\u001b[31munsafe-content-sentinel\u001b[0m'],
  ["stack trace", 'Failure\n at unsafe-content-sentinel (C:\\private\\module.js:1:1)'],
  ["oversized", "unsafe-content-sentinel".repeat(1000)],
]) {
  test(`unsafe provider body is omitted: ${kind}`, async () => {
    respond = () => { throw providerFailure({ error: text }); };
    const result = await execute(context());
    failed(result, "OLLAMA_ERROR_404");
    assert.match(result.errorMessage, /HTTP 404/);
    assert.ok(!/unsafe-content-sentinel|unsafe-script-sentinel|\u001b/.test(JSON.stringify(result)));
    assert.ok(result.errorMessage.length <= 512);
  });
}

test("safe long error text is bounded after redaction", async () => {
  respond = () => { throw providerFailure({ error: "Requested model is not installed. " + "detail ".repeat(500) + "fake-model-key" }); };
  const result = await execute(context());
  failed(result, "OLLAMA_ERROR_404");
  assert.match(result.errorMessage, /Requested model is not installed/);
  assert.ok(result.errorMessage.length <= 512);
  assert.ok(!JSON.stringify(result).includes("fake-model-key"));
});

test("malicious error accessors cannot throw or expose their contents during diagnosis", async () => {
  const malicious = Object.create(null, {
    message: { get() { throw new Error("getter-secret-sentinel"); } },
    isAxiosError: { get() { throw new Error("getter-secret-sentinel"); } },
  });
  respond = () => { throw malicious; };
  const result = await execute(context());
  failed(result);
  assert.ok(!JSON.stringify(result).includes("getter-secret-sentinel"));
});

test("proxy traps cannot escape the diagnostic fallback", async () => {
  const malicious = new Proxy({}, { getPrototypeOf() { throw new Error("proxy-secret-sentinel"); } });
  respond = () => { throw malicious; };
  const result = await execute(context("Explain addition", { env: { PRIVATE_SECRET: "proxy-secret-sentinel" } }));
  failed(result);
  assert.ok(!JSON.stringify(result).includes("proxy-secret-sentinel"));
});

test("Paperclip action errors also redact credentials", async () => {
  delegateTransport();
  const inner = respond;
  respond = call => {
    if (call.url.endsWith("/issues")) throw providerFailure({ error: "Denied fake-run-token; api_key=unconfigured-sentinel" }, "Forbidden", 403);
    return inner(call);
  };
  const logs = [];
  const run = context("Delegate to CTO");
  run.onLog = async (_stream, text) => logs.push(text);
  const result = await execute(run);
  failed(result, "PAPERCLIP_DELEGATION_FAILED");
  assert.ok(!/fake-run-token|unconfigured-sentinel/.test(JSON.stringify({ result, logs })));
  assert.match(result.resultJson.actions.at(-1).error, /HTTP 403/);
});

for (const stage of ["lookup", "planner", "metadata"]) {
  test(`diagnostic failures redact secrets at the ${stage} boundary`, async () => {
    delegateTransport();
    const inner = respond;
    respond = call => {
      if ((stage === "lookup" && call.method === "get") || (stage === "planner" && call.url.endsWith("/chat/completions"))) {
        throw providerFailure({ message: "Denied fake-run-token\nX-Secret-Header: opaque header value sentinel" }, "Forbidden", 403);
      }
      return inner(call);
    };
    const logs = [];
    const run = context("Delegate to CTO");
    run.onLog = async (_stream, text) => logs.push(text);
    if (stage === "metadata") run.onMeta = async () => { throw new Error("Metadata failed fake-run-token; secret=metadata-sentinel"); };
    const result = await execute(run);
    failed(result);
    assert.ok(!/fake-run-token|opaque|header value sentinel|metadata-sentinel/.test(JSON.stringify({ result, logs })));
  });
}

test("credentials cannot escape through a rejected planner-selected assignee", async () => {
  delegateTransport([agent()], plan({ assigneeName: "fake-run-token" }));
  const logs = [];
  const run = context("Delegate to CTO");
  run.onLog = async (_stream, text) => logs.push(text);
  run.onMeta = async meta => logs.push(JSON.stringify(meta.context));
  const result = await execute(run);
  failed(result, "PAPERCLIP_DELEGATION_FAILED");
  assert.ok(!JSON.stringify({ result, logs }).includes("fake-run-token"));
  noIssueCreation();
});

test("environment diagnostics preserve safe provider detail without leaking credentials", async () => {
  respond = () => { throw providerFailure({ error: "Requested model is not installed; API_KEY=fake-model-key" }); };
  const result = await testEnvironment({ companyId: "test-company", adapterType: "ollama_local", config: context().config });
  assert.equal(result.status, "fail");
  assert.match(result.checks.at(-1).detail, /HTTP 404.*Requested model is not installed/);
  assert.ok(!JSON.stringify(result).includes("fake-model-key"));
});

test("provider failure returns a failed result", async () => {
  respond = () => { throw new Error("Provider unavailable"); };
  failed(await execute(context()));
});

test("environment probe rejects unusable output and accepts complete text", async () => {
  const probe = { companyId: "test-company", adapterType: "ollama_local", config: context().config };
  for (const [, payload] of invalidResponses) {
    respond = () => payload;
    assert.equal((await testEnvironment(probe)).status, "fail");
  }
  respond = () => chat("ok");
  assert.equal((await testEnvironment(probe)).status, "pass");
});

test("prompt and intent helper smoke checks from previous suite remain covered", () => {
  const prompt = extractPrompt(context("", {}, { paperclipWakeComment: { body: "Research natural numbers." }, paperclipTaskMarkdown: "Old task: What is 1 + 1?" }));
  assert.ok(prompt.includes("Research natural numbers."));
  assert.ok(prompt.includes("Old task: What is 1 + 1?"));
  assert.equal(wantsCompanyContext("check our org chart and tell me who can help"), true);
  assert.equal(wantsDelegation("tell CTO to review this task"), true);
});

test("external adapter exports and factory contract remain available", () => {
  for (const name of ["type", "label", "models", "agentConfigurationDoc", "createServerAdapter"]) assert.ok(name in entry);
  const adapter = entry.createServerAdapter();
  assert.equal(adapter.type, "ollama_local");
  assert.equal(adapter.supportsLocalAgentJwt, true);
  for (const name of ["execute", "testEnvironment", "getConfigSchema"]) assert.equal(typeof adapter[name], "function");
});

test("package advertises the external factory rather than an invalid general-plugin manifest", async () => {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.paperclipPlugin, undefined);
  assert.equal(pkg.exports["."], "./dist/index.js");
  assert.equal(pkg.exports["./server"], "./dist/server/index.js");
  const legacy = await import("../dist/manifest.js");
  assert.equal(legacy.default.adapters[0].exportName, "createServerAdapter");
});
