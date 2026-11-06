import axios from "axios";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { AxiosResponse } from "axios";
import { ConfigurationError, validateBearerCredential, validateEndpoint } from "./config.js";
import type { OllamaConfig } from "./config.js";
import { ExecutionControl, executionError, requestControl } from "./lifecycle.js";
import type { ExecutionError } from "./lifecycle.js";
import { errorHttpStatus } from "./diagnostics.js";

type ServiceResponse = AxiosResponse & { interruption?: ExecutionError };

class HttpResponseError extends Error {
  readonly response: { status: number; data: unknown };
  constructor(status: number, data: unknown) {
    super(`Request failed with status code ${status}`);
    this.response = { status, data };
  }
}

function own(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; } catch { return undefined; }
}

export class WriteRequestError extends Error {
  readonly response?: { status: number; data: unknown };
  readonly persistence: "not_attempted" | "rejected" | "unknown";
  constructor(error: unknown, readonly attempted: boolean, readonly interruption?: ExecutionError) {
    const message = own(error, "message");
    super(interruption?.message ?? (typeof message === "string" ? message : "Paperclip write failed; inspect state before retrying."));
    const status = errorHttpStatus(error);
    if (status !== undefined) this.response = { status, data: own(own(error, "response"), "data") };
    // A timeout, 5xx or redirect is not evidence that the origin did not commit.
    this.persistence = !attempted ? "not_attempted" : status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 499 ? "rejected" : "unknown";
  }
}

function parseData(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try { return JSON.parse(data); } catch { return data; }
}

// Each instance owns its origin and credential. Callers cannot supply arbitrary
// URLs, headers, auth, proxies, or transport options through a task/model body.
function service(base: string, token: string | undefined, timeout: number, timeoutCode: "MODEL_REQUEST_TIMEOUT" | "PAPERCLIP_REQUEST_TIMEOUT", control?: ExecutionControl, runId?: string) {
  // Construct from explicit defaults instead of inheriting ambient Axios auth,
  // headers, params, interceptors or proxy configuration. Keep the mock transport
  // seam used by deterministic tests; production always uses Node's HTTP adapter.
  const transport = axios.getAdapter(typeof axios.defaults.adapter === "function" ? axios.defaults.adapter : "http");
  const client = new axios.Axios({
    adapter: transport,
    headers: {},
    proxy: false,
    // Node's global HTTP agent may itself honor --use-env-proxy, independently
    // of Axios's proxy option. Both protocols need private direct agents.
    httpAgent: new HttpAgent(),
    httpsAgent: new HttpsAgent({ rejectUnauthorized: true }),
    maxRedirects: 0,
    validateStatus: () => true,
    transformRequest: [data => data === undefined ? undefined : JSON.stringify(data)],
    transformResponse: [parseData],
  });
  return async (method: "GET" | "POST" | "PUT", route: string, body?: unknown, write = false): Promise<ServiceResponse> => {
    const url = `${base}${route}`;
    // Fixed adapter-owned routes must never resolve outside the configured origin.
    if (!route.startsWith("/") || route.startsWith("//") || new URL(url).origin !== new URL(base).origin) throw new ConfigurationError("request destination");
    const request = requestControl(timeout, timeoutCode, control);
    let attempted = false;
    let received: AxiosResponse | undefined;
    const checked = (response: AxiosResponse) => {
      if (response.status >= 300 && response.status < 400) throw new HttpResponseError(response.status, { message: "Redirects are disabled for authenticated service requests." });
      if (response.status < 200 || response.status >= 300) throw new HttpResponseError(response.status, response.data);
      return response;
    };
    const observedWrite = (response: AxiosResponse): ServiceResponse => {
      const accepted = checked(response);
      const interruption = executionError(request.failure(undefined));
      return interruption ? { ...accepted, interruption } : accepted;
    };
    try {
      control?.dispatch();
      request.check();
      attempted = true;
      const response = await client.request({
        method, url, data: body, timeout: request.timeoutMs, signal: request.signal,
        // Capture observed write responses before Axios checks cancellation again.
        // A later stop must not erase an already received authoritative receipt.
        adapter: async config => { const response = await transport(config); received = response; return response; },
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(runId ? { "X-Paperclip-Run-Id": runId } : {}) },
      });
      if (write) return observedWrite(response);
      request.check();
      return checked(response);
    } catch (error) {
      if (write && received) {
        try { return observedWrite({ ...received, data: parseData(received.data) }); } catch (observedError) { error = observedError; }
      }
      const failure = request.failure(error);
      if (write) throw new WriteRequestError(error, attempted, executionError(failure));
      throw failure;
    } finally { request.dispose(); }
  };
}

export function createServiceClients(config: OllamaConfig, authToken?: string, probeTimeout?: number, control?: ExecutionControl, runId?: string) {
  // Validate both destinations and credentials before constructing any request.
  const modelBase = validateEndpoint(config.baseUrl, "BASE_URL");
  const paperclipBase = validateEndpoint(config.paperclipBaseUrl, "PAPERCLIP_BASE_URL");
  const modelKey = validateBearerCredential(config.apiKey, "API_KEY");
  const runToken = validateBearerCredential(authToken, "run authentication");
  const model = service(modelBase, modelKey, Math.min(config.modelRequestTimeoutMs, probeTimeout ?? config.modelRequestTimeoutMs), "MODEL_REQUEST_TIMEOUT", control);
  const paperclip = service(paperclipBase, runToken, config.paperclipRequestTimeoutMs, "PAPERCLIP_REQUEST_TIMEOUT", control, validateBearerCredential(runId, "run identity"));
  function requireRunToken() {
    if (!runToken) throw new Error("missing_auth_token");
  }
  return {
    complete(body: unknown) { return model("POST", "/chat/completions", body); },
    listAgents(companyId: string) { requireRunToken(); return paperclip("GET", `/api/companies/${encodeURIComponent(companyId)}/agents`); },
    createIssue(companyId: string, body: unknown) { requireRunToken(); return paperclip("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, body, true); },
    getIssue(issueId: string) { requireRunToken(); return paperclip("GET", `/api/issues/${encodeURIComponent(issueId)}`); },
    getSelf() { requireRunToken(); return paperclip("GET", "/api/agents/me"); },
    getRun(runId: string) { requireRunToken(); return paperclip("GET", `/api/heartbeat-runs/${encodeURIComponent(runId)}`); },
    getDocument(issueId: string, key: string) { requireRunToken(); return paperclip("GET", `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`); },
    createDocument(issueId: string, key: string, body: string) {
      requireRunToken();
      return paperclip("PUT", `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`, {
        format: "markdown", title: "Ollama delegation safety record", body, baseRevisionId: null,
      }, true);
    },
  };
}

export type ServiceClients = ReturnType<typeof createServiceClients>;
