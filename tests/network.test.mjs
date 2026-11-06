import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import http from "node:http";
import https from "node:https";
import { Writable, Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import axios from "axios";
import { readOllamaConfig } from "../dist/server/config.js";
import { createServiceClients } from "../dist/server/http.js";
import { execute } from "../dist/server/execute.js";
import { testEnvironment } from "../dist/server/test.js";
import { createServerAdapter } from "../dist/server/index.js";

const envKeys = ["API_KEY", "apiKey", "BASE_URL", "baseUrl", "PAPERCLIP_BASE_URL", "paperclipBaseUrl", "PAPERCLIP_API_URL", "PAPERCLIP_RUNTIME_API_URL", "MODEL", "model", "TEMPERATURE", "temperature", "MAX_TOKENS", "maxTokens", "SYSTEM_PROMPT", "systemPrompt", "AUTO_MARK_DONE", "autoMarkDone", "ENABLE_PAPERCLIP_ACTIONS", "enablePaperclipActions", "HOST", "PORT", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT"];
const original = { http: http.request, https: https.request, adapter: axios.defaults.adapter };
let savedEnv, calls, respond;
const chat = content => ({ choices: [{ message: { content }, finish_reason: "stop" }] });

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  calls = [];
  respond = () => ({ status: 200, data: chat("Run ollama pull llama3") });
  // Exercise the real Axios HTTP adapter and its header/body serialization.
  // Replace only Node's terminal transports; no DNS or socket is opened.
  axios.defaults.adapter = "http";
  const request = (options, callback) => {
    const call = { options, body: "" }; calls.push(call);
    const req = new Writable({
      write(chunk, _encoding, done) { call.body += chunk.toString(); done(); },
      final(done) {
        done();
        queueMicrotask(() => {
          const result = respond(call);
          const res = Readable.from([JSON.stringify(result.data)]);
          res.statusCode = result.status;
          res.statusMessage = "Test fixture";
          res.headers = { "content-type": "application/json", ...result.headers };
          res.req = req;
          callback(res);
        });
      },
    });
    req.setTimeout = () => req;
    req.setKeepAlive = () => req;
    return req;
  };
  http.request = request; https.request = request;
});
afterEach(() => {
  http.request = original.http; https.request = original.https;
  axios.defaults.adapter = original.adapter;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});

function invocation(config = {}, prompt = "Explain addition") {
  return {
    runId: "network-review", agent: { id: "ceo", companyId: "company", name: "CEO", adapterType: "ollama_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue" },
    config: { BASE_URL: "http://localhost:11434/v1", PAPERCLIP_BASE_URL: "http://localhost:3100", ...config },
    context: { prompt }, authToken: "run-secret", onLog: async () => {},
  };
}
const authorization = call => call.options.headers.Authorization ?? call.options.headers.authorization;

for (const field of ["BASE_URL", "PAPERCLIP_BASE_URL"]) {
  for (const url of ["http://127.attacker.invalid", "http://127.0.0.1.attacker.invalid", "http://%31%32%37.attacker.invalid", "http://localhost.attacker.invalid", "https:////@remote.invalid", "https:///remote.invalid", "https:////remote.invalid", "https://@remote.invalid", "http:////localhost:11434/v1"]) {
    test(`real transport is never reached for invalid ${field}: ${url}`, async () => {
      const result = await execute(invocation({ [field]: url }));
      assert.equal(result.errorCode, "INVALID_CONFIGURATION");
      assert.equal(result.exitCode, 1);
      assert.equal(result.resultJson.workflowCompleted, false);
      assert.equal(calls.length, 0);
    });
  }
}

for (const base of ["http://localhost:11434", "http://127.0.0.1:11434", "http://127.1:11434", "http://127.255.255.254:11434", "http://[::1]:11434", "http://[0:0:0:0:0:0:0:1]:11434", "https://remote.invalid/prefix"]) {
  test(`valid endpoint reaches real Axios preparation for both clients: ${base}`, async () => {
    const clients = createServiceClients(readOllamaConfig({ BASE_URL: `${base}/v1`, PAPERCLIP_BASE_URL: base, API_KEY: "model-secret" }), "run-secret");
    await clients.complete({ model: "test", messages: [] });
    await clients.listAgents("company");
    assert.equal(calls.length, 2);
    assert.equal(authorization(calls[0]), "Bearer model-secret");
    assert.equal(authorization(calls[1]), "Bearer run-secret");
    assert.equal(calls[0].options.hostname, new URL(base).hostname.replace(/^\[|\]$/g, ""));
    assert.deepEqual(JSON.parse(calls[0].body), { model: "test", messages: [] });
  });
}

for (const which of ["model", "paperclip"]) {
  for (const key of ["review-\u{1f512}-credential", "review-\ud800-credential", "review-\u00e9-credential", " leading-key", "trailing-key ", "internal key", "key\tvalue", "key\u0000value", "key\r\nvalue", "key\n", "key\r", "key\u007f", "key\u2028"]) {
    test(`invalid ${which} credential fails before Node request preparation: ${JSON.stringify(key)}`, async () => {
      const logs = [], meta = [];
      const run = invocation({ API_KEY: which === "model" ? key : "model-secret" });
      if (which === "paperclip") run.authToken = key;
      run.onLog = async (_stream, text) => logs.push(text);
      run.onMeta = async value => meta.push(value);
      const result = await execute(run);
      assert.equal(result.errorCode, "INVALID_CONFIGURATION");
      assert.equal(calls.length, 0);
      const surfaces = JSON.stringify({ result, logs, meta });
      assert.ok(!surfaces.includes(JSON.stringify(key).slice(1, -1)));
      assert.ok(!surfaces.includes("review--credential"));
    });
  }
}

for (const protocol of ["http", "https"]) {
  test(`real Axios serializes valid credentials unchanged and separately over ${protocol}`, async () => {
    const modelKey = "Model-AZ09._~+/==", runKey = "Run-AZ09._~+/==";
    const base = protocol === "http" ? "http://localhost:3100" : "https://service.invalid";
    const clients = createServiceClients(readOllamaConfig({ BASE_URL: `${base}/v1`, PAPERCLIP_BASE_URL: base, API_KEY: modelKey }), runKey);
    await clients.complete({ messages: [] }); await clients.listAgents("company");
    assert.deepEqual(calls.map(authorization), [`Bearer ${modelKey}`, `Bearer ${runKey}`]);
    assert.ok(calls.every(call => !call.body.includes(modelKey) && !call.body.includes(runKey)));
    for (const call of calls) {
      const global = protocol === "http" ? http.globalAgent : https.globalAgent;
      assert.notEqual(call.options.agent, global);
      assert.equal(call.options.agent.options.proxyEnv, undefined);
      if (protocol === "https") assert.equal(call.options.agent.options.rejectUnauthorized, true);
    }
  });
}

for (const target of ["model", "paperclip"]) {
  test(`real provider diagnostics redact both credentials after ${target} rejection`, async () => {
    respond = () => ({ status: 401, data: { error: { message: "Provider echoed model-secret and run-secret" } } });
    const logs = [], meta = [];
    const run = invocation({ API_KEY: "model-secret" }, target === "paperclip" ? "Who are our agents?" : "Explain addition");
    run.onLog = async (_stream, text) => logs.push(text);
    run.onMeta = async value => meta.push(value);
    const result = await execute(run);
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage, /HTTP 401/);
    assert.ok(!/model-secret|run-secret/.test(JSON.stringify({ result, logs, meta })));
    assert.equal(calls.length, 1);
    assert.equal(authorization(calls[0]), target === "model" ? "Bearer model-secret" : "Bearer run-secret");
  });
}

test("implicit public placeholder preserves successful text, logs and metadata", async () => {
  const logs = [], meta = [];
  const run = invocation();
  run.onLog = async (_stream, text) => logs.push(text);
  run.onMeta = async value => meta.push(value);
  const result = await execute(run);
  assert.equal(result.summary, "Run ollama pull llama3");
  assert.equal(logs.at(-1), "Run ollama pull llama3");
  assert.equal(meta[0].command, "ollama-openai-chat-completions");
  assert.equal(authorization(calls[0]), "Bearer ollama");
});

test("schema leaves the public placeholder implicit instead of persisting it as a secret", () => {
  const field = createServerAdapter().getConfigSchema().fields.find(field => field.key === "API_KEY");
  assert.ok(field);
  assert.equal(field.default, undefined);
});

test("environment probe preserves implicit placeholder words in its model diagnostic", async () => {
  const result = await testEnvironment({ companyId: "company", adapterType: "ollama_local", config: { ...invocation().config, MODEL: "ollama-model" } });
  assert.equal(result.status, "pass");
  assert.match(result.checks[0].message, /Using ollama-model/);
  assert.equal(authorization(calls[0]), "Bearer ollama");
});

for (const source of ["config", "agentEnv", "process"]) {
  test(`explicit ollama credential remains secret from ${source}`, async () => {
    const config = source === "config" ? { API_KEY: "ollama" } : source === "agentEnv" ? { env: { apiKey: "ollama" } } : {};
    if (source === "process") process.env.API_KEY = "ollama";
    const logs = [], meta = [];
    const run = invocation(config);
    run.onLog = async (_stream, text) => logs.push(text);
    run.onMeta = async value => meta.push(value);
    const result = await execute(run);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary, "Run [REDACTED] pull llama3");
    assert.ok(!JSON.stringify({ logs, meta }).includes("ollama"));
  });
}

for (const protocol of ["http", "https"]) {
  for (const target of ["model", "paperclip"]) {
    test(`real Axios rejects ${protocol} ${target} redirects without another request`, async () => {
      respond = () => ({ status: 307, data: chat("must not accept"), headers: { location: "https://other.invalid/steal" } });
      const base = protocol === "http" ? "http://localhost:3100" : "https://service.invalid";
      const clients = createServiceClients(readOllamaConfig({ BASE_URL: `${base}/v1`, PAPERCLIP_BASE_URL: base, API_KEY: "model-secret" }), "run-secret");
      await assert.rejects(target === "model" ? clients.complete({ messages: [] }) : clients.listAgents("company"), error => error.response?.status === 307);
      assert.equal(calls.length, 1);
    });
  }
}

for (const source of ["config", "agentEnv", "process", "task"]) {
  for (const limit of ["2048", "1"]) {
    test(`public numeric settings retain output and metadata from ${source}: ${limit}`, async () => {
      const settings = { MAX_TOKENS: limit, TEMPERATURE: "0.7" };
      const config = { API_KEY: "model-secret", ...(source === "config" ? settings : source === "agentEnv" ? { env: settings } : {}) };
      if (source === "process") Object.assign(process.env, settings);
      respond = () => ({ status: 200, data: chat("2048 and 1; temperature 0.7; model-secret run-secret") });
      const logs = [], meta = [];
      const run = invocation(config);
      if (source === "task") run.context.options = { maxTokens: limit, temperature: "0.7" };
      run.onLog = async (_s, text) => logs.push(text);
      run.onMeta = async value => meta.push(value);
      const result = await execute(run);
      assert.equal(result.exitCode, 0);
      assert.equal(result.summary, "2048 and 1; temperature 0.7; [REDACTED] [REDACTED]");
      assert.equal(logs.at(-1), result.summary);
      assert.equal(meta[0].env.MAX_TOKENS, limit);
      assert.equal(meta[0].env.TEMPERATURE, "0.7");
      assert.equal(JSON.parse(calls[0].body).max_tokens, Number(limit));
    });
  }
}

function receiptTransport(receipt, agentId = "cto") {
  respond = call => ({ status: 200, data: call.options.method === "GET"
    ? [{ id: agentId, name: "Alex", role: "cto", status: "idle" }]
    : call.options.path.endsWith("/issues") ? receipt
    : chat('{"shouldDelegate":true,"assigneeName":"CTO","title":"Review","description":"Review design"}') });
}

async function receiptResult(receipt) {
  receiptTransport(receipt);
  const logs = [], meta = [], run = invocation({ API_KEY: "model-secret" }, "Delegate to CTO");
  run.onLog = async (_s, text) => logs.push(text);
  run.onMeta = async value => meta.push(value);
  const result = await execute(run);
  assert.equal(calls.filter(call => call.options.path.endsWith("/issues")).length, 1);
  assert.equal(result.resultJson.workflowCompleted, false);
  assert.ok(!/model-secret|run-secret|hostile-extra/.test(JSON.stringify({ result, logs, meta })));
  return result;
}

for (const identifier of [{ "run-secret": "echo" }, ["run-secret"], 12, true, null, undefined, "", " ", "bad\nvalue", "<html>run-secret</html>"]) {
  test(`malformed optional receipt identifier cannot enter metadata: ${JSON.stringify(identifier)}`, async () => {
    const result = await receiptResult({ id: "child", assigneeAgentId: "cto", identifier, extra: { "model-secret": "hostile-extra" } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.resultJson.stopReason, "delegated");
    assert.equal(result.resultJson.actions.at(-1).issueId, "child");
    assert.equal(result.resultJson.actions.at(-1).identifier, null);
  });
}

for (const id of [undefined, null, "", " ", 12, true, [], { "run-secret": "echo" }, "child\n", "run-secret", "child-run-secret"]) {
  test(`invalid required receipt ID never claims delegation: ${JSON.stringify(id)}`, async () => {
    const result = await receiptResult({ id, assigneeAgentId: "cto", identifier: { "run-secret": "echo" } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.resultJson.actions.at(-1).reason, "invalid_issue_receipt");
    assert.equal(result.resultJson.actions.at(-1).success, false);
  });
}

for (const assigneeAgentId of [null, 12, true, [], { "run-secret": "echo" }, "someone-else"]) {
  test(`invalid receipt assignment preserves ID without claiming success: ${JSON.stringify(assigneeAgentId)}`, async () => {
    const result = await receiptResult({ id: "child", assigneeAgentId, identifier: { "run-secret": "echo" } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.resultJson.actions.at(-1).issueId, "child");
    assert.equal(result.resultJson.actions.at(-1).reason, "assignment_not_verified");
  });
}

for (const receipt of [{ id: "child", identifier: "TEST-2" }, { id: "child", assigneeAgentId: "cto", identifier: "TEST-2" }, { id: "child", assigneeAgentId: "cto", identifier: "TEST-run-secret" }]) {
  test(`valid scalar receipt retains verified ID and safe display identifier: ${JSON.stringify(receipt)}`, async () => {
    const result = await receiptResult(receipt);
    assert.equal(result.exitCode, 0);
    assert.equal(result.resultJson.actions.at(-1).issueId, "child");
    assert.equal(result.resultJson.actions.at(-1).identifier, receipt.identifier.replace("run-secret", "[REDACTED]"));
  });
}

test("credential-bearing agent IDs cannot be persisted or used for mutation", async () => {
  receiptTransport({ id: "child" }, "run-secret");
  const meta = [], run = invocation({ API_KEY: "model-secret" }, "Delegate to CTO");
  run.onMeta = async value => meta.push(value);
  const result = await execute(run);
  assert.equal(result.exitCode, 1);
  assert.equal(result.resultJson.actions.at(-1).reason, "invalid_assignee_id");
  assert.ok(!JSON.stringify({ result, meta }).includes("run-secret"));
  assert.equal(calls.filter(call => call.options.path.endsWith("/issues")).length, 0);
});

for (const mode of ["flag", "environment"]) {
  test(`native Node agent selection bypasses global proxy (${mode}) with sockets intercepted`, t => {
    const supportsFlag = process.allowedNodeEnvironmentFlags.has("--use-env-proxy");
    if (mode === "flag" && !supportsFlag) { t.skip(`--use-env-proxy is unsupported on ${process.version}`); return; }
    const args = mode === "flag" ? ["--use-env-proxy"] : [];
    const result = spawnSync(process.execPath, [...args, "tests/fixtures/direct-agents.mjs"], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: "", NODE_USE_ENV_PROXY: mode === "environment" ? "1" : "0", HTTP_PROXY: "http://review-proxy.invalid:8080", http_proxy: "http://review-proxy.invalid:8080", HTTPS_PROXY: "http://review-proxy.invalid:8080", https_proxy: "http://review-proxy.invalid:8080", NO_PROXY: "", no_proxy: "" },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const { attempts, requests, proxyControl, socketGuardActive } = JSON.parse(result.stdout);
    assert.equal(socketGuardActive, true, "captured Node connection functions must still be intercepted");
    if (mode === "environment" && !proxyControl.active) { t.skip(`NODE_USE_ENV_PROXY did not activate a global proxy on ${process.version}; feature not verified`); return; }
    assert.equal(proxyControl.active, true, "global-agent positive control must actually select the proxy");
    assert.deepEqual(attempts.map(entry => entry.host), ["localhost", "127.0.0.1", "model.invalid", "paperclip.invalid"]);
    assert.deepEqual(attempts.map(entry => entry.kind), ["tcp", "tcp", "tls", "tls"]);
    assert.deepEqual(attempts.map(entry => entry.port), [11434, 3100, 443, 443]);
    assert.deepEqual(requests.map(entry => entry.authorization), ["Bearer model-secret", "Bearer run-secret", "Bearer model-secret", "Bearer run-secret"]);
    assert.ok(requests.every(entry => entry.ownAgent && !entry.proxyEnv));
    assert.ok(attempts.filter(entry => entry.kind === "tls").every(entry => entry.verifyTLS === true));
    assert.equal(attempts.length, 4);
    t.diagnostic(`${mode === "flag" ? "--use-env-proxy" : "NODE_USE_ENV_PROXY"} exercised on ${process.version}: global proxy activated; private TCP/TLS agents stayed direct`);
  });
}
