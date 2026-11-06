import { delegationFixture } from "./helpers/delegation.mjs";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import axios from "axios";
import { readOllamaConfig } from "../dist/server/config.js";
import { execute } from "../dist/server/execute.js";
import { testEnvironment } from "../dist/server/test.js";

const envKeys = ["BASE_URL", "baseUrl", "API_KEY", "apiKey", "MODEL", "model", "TEMPERATURE", "temperature", "MAX_TOKENS", "maxTokens", "SYSTEM_PROMPT", "systemPrompt", "AUTO_MARK_DONE", "autoMarkDone", "ENABLE_PAPERCLIP_ACTIONS", "enablePaperclipActions", "PAPERCLIP_BASE_URL", "paperclipBaseUrl", "PAPERCLIP_API_URL", "PAPERCLIP_RUNTIME_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT", "HOST", "PORT"];
const transport = axios.defaults.adapter;
let previousEnv, calls, respond, journalFixture;
const chat = content => ({ choices: [{ message: { content }, finish_reason: "stop" }] });
const agents = [{ id: "cto", name: "Alex", role: "cto", status: "idle" }];
const plan = chat('{"shouldDelegate":true,"assigneeName":"CTO","title":"Review","description":"Review design"}');
beforeEach(() => {
  previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  calls = []; journalFixture = delegationFixture({ company: "company", source: "issue" });
  respond = () => chat("General answer");
  axios.defaults.adapter = async config => {
    const auxiliary = journalFixture.auxiliary(config); if (auxiliary) return auxiliary;
    const call = { method: config.method, url: config.url, headers: config.headers.toJSON(), auth: config.auth, proxy: config.proxy,
      rejectUnauthorized: config.httpsAgent?.options.rejectUnauthorized,
      maxRedirects: config.maxRedirects, data: typeof config.data === "string" ? JSON.parse(config.data) : config.data };
    calls.push(call);
    const result = await respond(call); journalFixture.observe(config, result?.data ?? result);
    return { status: 200, statusText: "OK", headers: {}, config, ...result, data: result?.data ?? result };
  };
});
afterEach(() => {
  axios.defaults.adapter = transport;
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
  }
});
function run(prompt = "Explain addition", config = {}, wake = {}) {
  return { runId: "boundary-run", agent: { id: "ceo", companyId: "company", name: "CEO", adapterType: "ollama_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue" },
    config: { DELEGATION_STORAGE: "paperclip_documents_v1", BASE_URL: "https://model.invalid/v1", PAPERCLIP_BASE_URL: "https://paperclip.invalid", API_KEY: "model-secret", MODEL: "trusted-model", ...config },
    context: { issueId: "issue", prompt, ...wake }, authToken: "run-secret", onLog: async () => {} };
}
function delegation() {
  respond = call => call.method === "get" ? agents : call.url.endsWith("/chat/completions") ? plan : { id: "child", assigneeAgentId: "cto" };
}
function configurationFailed(result) {
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorCode, "INVALID_CONFIGURATION");
  assert.equal(result.resultJson.success, false);
  assert.equal(result.resultJson.workflowCompleted, false);
  assert.equal(calls.length, 0);
}

for (const [upper, camel, field, values] of [
  ["MODEL", "model", "model", ["explicit", "agent-env", "process"]],
  ["API_KEY", "apiKey", "apiKey", ["explicit-secret", "env-secret", "process-secret"]],
  ["BASE_URL", "baseUrl", "baseUrl", ["https://explicit.invalid/v1", "https://agent.invalid/v1", "https://process.invalid/v1"]],
  ["PAPERCLIP_BASE_URL", "paperclipBaseUrl", "paperclipBaseUrl", ["https://explicit.invalid", "https://agent.invalid", "https://process.invalid"]],
  ["TEMPERATURE", "temperature", "temperature", [0, 0.2, 0.8]],
  ["MAX_TOKENS", "maxTokens", "maxTokens", [100, 200, 300]],
  ["ENABLE_PAPERCLIP_ACTIONS", "enablePaperclipActions", "enablePaperclipActions", [false, true, true]],
  ["AUTO_MARK_DONE", "autoMarkDone", "autoMarkDone", [false, true, true]],
  ["SYSTEM_PROMPT", "systemPrompt", "systemPrompt", ["explicit", "agent-env", "process"]],
]) {
  test(`explicit camelCase beats agent and process uppercase: ${field}`, () => {
    process.env[upper] = String(values[2]);
    assert.equal(readOllamaConfig({ [camel]: values[0], env: { [upper]: String(values[1]) } })[field], values[0]);
  });
  test(`agent environment camelCase beats process uppercase: ${field}`, () => {
    process.env[upper] = String(values[2]);
    assert.equal(readOllamaConfig({ env: { [camel]: String(values[1]) } })[field], values[1]);
  });
  test(`uppercase wins same-level alias conflict: ${field}`, () => {
    assert.equal(readOllamaConfig({ [upper]: values[0], [camel]: values[1] })[field], values[0]);
    assert.equal(readOllamaConfig({ env: { [upper]: String(values[0]), [camel]: String(values[1]) } })[field], values[0]);
    process.env[upper] = String(values[0]); process.env[camel] = String(values[1]);
    // Windows folds environment variable names: MODEL/model and
    // TEMPERATURE/temperature are one OS entry, so the last assignment wins.
    const foldedByOS = process.platform === "win32" && upper.toLowerCase() === camel.toLowerCase();
    assert.equal(readOllamaConfig()[field], foldedByOS ? values[1] : values[0]);
  });
}

test("absent endpoints use local defaults, and explicit empty API key omits model authorization", async () => {
  const config = readOllamaConfig();
  assert.equal(config.baseUrl, "http://localhost:11434/v1");
  assert.equal(config.paperclipBaseUrl, "http://localhost:3100");
  assert.equal((await execute(run("Explain addition", { API_KEY: "" }))).exitCode, 0);
  assert.equal(calls[0].headers.Authorization, undefined);
});

test("host runtime API URL uses official priority without accepting agent identity replacements", async () => {
  process.env.PAPERCLIP_API_URL = "https://host-api.invalid/prefix";
  process.env.PAPERCLIP_RUNTIME_API_URL = "https://runtime-fallback.invalid";
  process.env.PAPERCLIP_API_KEY = "ambient-token-must-not-be-used";
  const invocation = run("Who are our agents?", { env: { PAPERCLIP_API_URL: "https://untrusted.invalid", PAPERCLIP_API_KEY: "agent-env-token" } });
  delete invocation.config.PAPERCLIP_BASE_URL;
  respond = call => call.method === "get" ? agents : chat("Alex is the CTO");
  assert.equal((await execute(invocation)).exitCode, 0);
  assert.equal(calls[0].url, "https://host-api.invalid/prefix/api/companies/company/agents");
  assert.equal(calls[0].headers.Authorization, "Bearer run-secret");
});

test("runtime URL fallback and host/port derivation remain supported", () => {
  process.env.PAPERCLIP_RUNTIME_API_URL = "https://runtime.invalid";
  assert.equal(readOllamaConfig().paperclipBaseUrl, "https://runtime.invalid");
  delete process.env.PAPERCLIP_RUNTIME_API_URL;
  process.env.PAPERCLIP_LISTEN_HOST = "::"; process.env.PAPERCLIP_LISTEN_PORT = "3200";
  assert.equal(readOllamaConfig().paperclipBaseUrl, "http://localhost:3200");
  process.env.PAPERCLIP_LISTEN_HOST = "::1";
  assert.equal(readOllamaConfig().paperclipBaseUrl, "http://[::1]:3200");
});

test("permitted sampling overrides normalize aliases independently at each task level", async () => {
  const result = await execute(run("Explain addition", { TEMPERATURE: 0.7, MAX_TOKENS: 200 }, {
    task: { options: { TEMPERATURE: 0.3, MAX_TOKENS: 80 } }, options: { temperature: 0, maxTokens: 50 },
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].data.temperature, 0);
  assert.equal(calls[0].data.max_tokens, 50);
});

for (const nested of [false, true]) {
  test(`task overrides cannot alter destinations, credentials, model or instructions (nested: ${nested})`, async () => {
    const options = { BASE_URL: "https://attacker.invalid", baseUrl: "https://attacker.invalid", API_KEY: "injected-model-key", apiKey: "injected-model-key",
      PAPERCLIP_BASE_URL: "https://attacker.invalid", paperclipBaseUrl: "https://attacker.invalid", PAPERCLIP_API_URL: "https://attacker.invalid",
      authToken: "injected-run-key", PAPERCLIP_API_KEY: "injected-run-key", MODEL: "untrusted-model", model: "untrusted-model",
      SYSTEM_PROMPT: "untrusted-system", systemPrompt: "untrusted-system", env: { BASE_URL: "https://attacker.invalid", API_KEY: "nested-secret" } };
    delegation();
    const result = await execute(run("Delegate to CTO", {}, nested ? { task: { options } } : { options }));
    assert.equal(result.exitCode, 0);
    assert.equal(calls[0].url, "https://paperclip.invalid/api/companies/company/agents");
    assert.equal(calls[0].headers.Authorization, "Bearer run-secret");
    assert.equal(calls[1].url, "https://model.invalid/v1/chat/completions");
    assert.equal(calls[1].data.model, "trusted-model");
    assert.equal(calls[1].headers.Authorization, "Bearer model-secret");
    assert.ok(!JSON.stringify(calls).includes("attacker.invalid"));
  });
}

test("task requests cannot enable organizational permissions or automatic completion", async () => {
  const result = await execute(run("Delegate to CTO", { ENABLE_PAPERCLIP_ACTIONS: false }, {
    options: { ENABLE_PAPERCLIP_ACTIONS: true, enablePaperclipActions: true, AUTO_MARK_DONE: true, autoMarkDone: true },
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorCode, "PAPERCLIP_ACTIONS_DISABLED");
  assert.equal(calls.length, 0);
  assert.equal(result.resultJson.disposition.reason, "disabled");
});

for (const field of ["BASE_URL", "PAPERCLIP_BASE_URL"]) {
  for (const invalid of ["", " ", null, 42, "not a URL", "/relative", "https:service.invalid", "ftp://service.invalid", "https://user:password-sentinel@service.invalid", "https://@service.invalid", "https://service.invalid/?token=secret", "https://service.invalid/#fragment", "https://service.invalid\\other", "http://remote.invalid", "https://service.invalid/\npath"]) {
    test(`invalid ${field} fails before any request: ${JSON.stringify(invalid)}`, async () => {
      const logs = [];
      const invocation = run("Explain addition", { [field]: invalid });
      invocation.onLog = async (_stream, text) => logs.push(text);
      const result = await execute(invocation);
      configurationFailed(result);
      assert.ok(!JSON.stringify({ result, logs }).includes("password-sentinel"));
    });
  }
}

test("invalid explicit URL never falls back to a valid agent environment or process URL", async () => {
  process.env.BASE_URL = "https://process.invalid/v1";
  configurationFailed(await execute(run("Explain addition", { BASE_URL: "", env: { BASE_URL: "https://agent.invalid/v1" } })));
});

test("invalid host runtime URL never falls back to localhost", async () => {
  process.env.PAPERCLIP_API_URL = "not-valid";
  const invocation = run(); delete invocation.config.PAPERCLIP_BASE_URL;
  configurationFailed(await execute(invocation));
});

for (const endpoint of ["http://localhost:11434/v1/", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1", "https://remote.invalid/proxy/v1/"]) {
  test(`supported endpoint preserves base path: ${endpoint}`, async () => {
    assert.equal((await execute(run("Explain addition", { BASE_URL: endpoint }))).exitCode, 0);
    assert.equal(calls[0].url, `${endpoint.replace(/\/+$/, "")}/chat/completions`);
  });
}

test("separate clients do not inherit ambient Axios authentication or headers", async () => {
  const savedAuth = axios.defaults.auth;
  const savedHeader = axios.defaults.headers.common["X-Api-Key"];
  const savedAuthorization = axios.defaults.headers.common.Authorization;
  try {
    axios.defaults.auth = { username: "ambient-user", password: "ambient-password" };
    axios.defaults.headers.common["X-Api-Key"] = "ambient-key";
    axios.defaults.headers.common.Authorization = "Bearer ambient-token";
    delegation(); await execute(run("Delegate to CTO"));
    assert.ok(calls.length >= 3);
    for (const call of calls) {
      assert.equal(call.auth, undefined);
      assert.equal(call.headers["X-Api-Key"], undefined);
      assert.equal(call.headers.Authorization, call.url.startsWith("https://model.invalid/") ? "Bearer model-secret" : "Bearer run-secret");
      assert.equal(call.proxy, false);
      assert.equal(call.maxRedirects, 0);
      assert.equal(call.rejectUnauthorized, true);
    }
  } finally {
    axios.defaults.auth = savedAuth;
    if (savedHeader === undefined) delete axios.defaults.headers.common["X-Api-Key"]; else axios.defaults.headers.common["X-Api-Key"] = savedHeader;
    if (savedAuthorization === undefined) delete axios.defaults.headers.common.Authorization; else axios.defaults.headers.common.Authorization = savedAuthorization;
  }
});

for (const [field, value] of [["API_KEY", "key-secret\r\n"], ["API_KEY", "key-secret\nHeader: injected"], ["ENABLE_PAPERCLIP_ACTIONS", "not-a-boolean"], ["TEMPERATURE", -1], ["MAX_TOKENS", 1.5]]) {
  test(`malformed trusted ${field} fails before any request`, async () => {
    configurationFailed(await execute(run("Explain addition", { [field]: value })));
  });
}

test("malformed run token is rejected before inference or lookup", async () => {
  const invocation = run(); invocation.authToken = "run-secret\r\nHeader: injected";
  configurationFailed(await execute(invocation));
});

test("task sampling cannot repair invalid trusted configuration", async () => {
  configurationFailed(await execute(run("Explain addition", { TEMPERATURE: -1 }, { options: { temperature: 0 } })));
});

test("issue creation redirect cannot be mistaken for a confirmed receipt", async () => {
  delegation(); const inner = respond;
  respond = call => call.url.endsWith("/issues") ? { status: 307, data: { id: "must-not-accept" } } : inner(call);
  const result = await execute(run("Delegate to CTO"));
  assert.equal(result.exitCode, 1);
  assert.equal(result.resultJson.actions.at(-1).success, false);
  assert.equal(result.resultJson.actions.at(-1).status, 307);
  assert.equal(calls.length, 3);
});

test("same-origin redirects are also disabled", async () => {
  respond = () => ({ status: 302, headers: { location: "https://model.invalid/new-path" }, data: chat("not accepted") });
  assert.equal((await execute(run())).exitCode, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxRedirects, 0);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`model redirect is rejected without forwarding credentials: ${status}`, async () => {
    respond = () => ({ status, headers: { location: "https://attacker.invalid/steal" }, data: chat("Must not be accepted") });
    const result = await execute(run());
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorCode, `OLLAMA_ERROR_${status}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxRedirects, 0);
    assert.ok(!JSON.stringify(result).includes("model-secret"));
  });
}

test("Paperclip redirect fails a required lookup before planner or mutation", async () => {
  respond = () => ({ status: 302, headers: { location: "https://attacker.invalid" }, data: [] });
  const result = await execute(run("Delegate to CTO"));
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxRedirects, 0);
  assert.equal(calls[0].headers.Authorization, "Bearer run-secret");
});

test("missing run authentication is not replaced by model, process or agent environment keys", async () => {
  process.env.PAPERCLIP_API_KEY = "process-run-key";
  const invocation = run("Who are our agents?", { env: { PAPERCLIP_API_KEY: "agent-run-key" } });
  delete invocation.authToken;
  const result = await execute(invocation);
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorCode, "PAPERCLIP_CONTEXT_FAILED");
  assert.equal(calls.length, 0);
});

test("optional enrichment redirect still permits a generic answer", async () => {
  respond = call => call.method === "get" ? { status: 302, data: [] } : chat("Generic advice");
  const result = await execute(run("Suggest a workflow for our team"));
  assert.equal(result.exitCode, 0);
  assert.equal(result.resultJson.actions[0].success, false);
  assert.equal(result.resultJson.actions[0].required, false);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.url.includes("attacker")));
});

test("environment probe shares preflight validation and redirect policy", async () => {
  let result = await testEnvironment({ companyId: "company", adapterType: "ollama_local", config: { BASE_URL: "https://user:secret@model.invalid" } });
  assert.equal(result.status, "fail"); assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(result).includes("user:secret"));
  respond = () => ({ status: 307, data: chat("ok") });
  result = await testEnvironment({ companyId: "company", adapterType: "ollama_local", config: run().config });
  assert.equal(result.status, "fail"); assert.equal(calls.length, 1);
  assert.equal(calls[0].maxRedirects, 0);
});

test("credentials are redacted from successful logs and invocation metadata too", async () => {
  const logs = [], meta = [];
  respond = () => chat("Provider echoed model-secret and run-secret");
  const invocation = run("User supplied model-secret and run-secret");
  invocation.onLog = async (_stream, text) => logs.push(text);
  invocation.onMeta = async value => meta.push(value);
  const result = await execute(invocation);
  assert.equal(result.exitCode, 0);
  assert.ok(!/model-secret|run-secret/.test(JSON.stringify({ logs, meta })));
});
