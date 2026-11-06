import axios from "axios";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { AxiosResponse } from "axios";
import { ConfigurationError, validateBearerCredential, validateEndpoint } from "./config.js";
import type { OllamaConfig } from "./config.js";

class HttpResponseError extends Error {
  readonly response: { status: number; data: unknown };
  constructor(status: number, data: unknown) {
    super(`Request failed with status code ${status}`);
    this.response = { status, data };
  }
}

// Each instance owns its origin and credential. Callers cannot supply arbitrary
// URLs, headers, auth, proxies, or transport options through a task/model body.
function service(base: string, token: string | undefined, timeout?: number) {
  // Construct from explicit defaults instead of inheriting ambient Axios auth,
  // headers, params, interceptors or proxy configuration. Keep the mock transport
  // seam used by deterministic tests; production always uses Node's HTTP adapter.
  const client = new axios.Axios({
    adapter: typeof axios.defaults.adapter === "function" ? axios.defaults.adapter : "http",
    headers: {},
    proxy: false,
    // Node's global HTTP agent may itself honor --use-env-proxy, independently
    // of Axios's proxy option. Both protocols need private direct agents.
    httpAgent: new HttpAgent(),
    httpsAgent: new HttpsAgent({ rejectUnauthorized: true }),
    maxRedirects: 0,
    validateStatus: () => true,
    transformRequest: [data => data === undefined ? undefined : JSON.stringify(data)],
    transformResponse: [data => {
      if (typeof data !== "string") return data;
      try { return JSON.parse(data); } catch { return data; }
    }],
  });
  return async (method: "GET" | "POST", route: string, body?: unknown): Promise<AxiosResponse> => {
    const url = `${base}${route}`;
    // Fixed adapter-owned routes must never resolve outside the configured origin.
    if (!route.startsWith("/") || route.startsWith("//") || new URL(url).origin !== new URL(base).origin) throw new ConfigurationError("request destination");
    const response = await client.request({
      method, url, data: body, timeout,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (response.status >= 300 && response.status < 400) throw new HttpResponseError(response.status, { message: "Redirects are disabled for authenticated service requests." });
    if (response.status < 200 || response.status >= 300) throw new HttpResponseError(response.status, response.data);
    return response;
  };
}

export function createServiceClients(config: OllamaConfig, authToken?: string, probeTimeout?: number) {
  // Validate both destinations and credentials before constructing any request.
  const modelBase = validateEndpoint(config.baseUrl, "BASE_URL");
  const paperclipBase = validateEndpoint(config.paperclipBaseUrl, "PAPERCLIP_BASE_URL");
  const modelKey = validateBearerCredential(config.apiKey, "API_KEY");
  const runToken = validateBearerCredential(authToken, "run authentication");
  const model = service(modelBase, modelKey, probeTimeout);
  const paperclip = service(paperclipBase, runToken);
  function requireRunToken() {
    if (!runToken) throw new Error("missing_auth_token");
  }
  return {
    complete(body: unknown) { return model("POST", "/chat/completions", body); },
    listAgents(companyId: string) { requireRunToken(); return paperclip("GET", `/api/companies/${encodeURIComponent(companyId)}/agents`); },
    createIssue(companyId: string, body: unknown) { requireRunToken(); return paperclip("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, body); },
  };
}

export type ServiceClients = ReturnType<typeof createServiceClients>;
