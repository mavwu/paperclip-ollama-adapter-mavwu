// Auxiliary ownership/document fixtures for the pre-Batch-3 suites. Their
// `calls` arrays continue measuring the original lookup/planner/create traffic.
// replay.test.mjs separately records and asserts EVERY request and mutation.
export function delegationFixture({ company = "company", source = "issue", agent = "ceo" } = {}) {
  const docs = new Map(), children = new Map();
  return {
    auxiliary(config) {
      const path = new URL(config.url).pathname;
      const runId = config.headers?.get?.("X-Paperclip-Run-Id") ?? config.headers?.["X-Paperclip-Run-Id"];
      if (path.endsWith("/api/agents/me")) return { config, status: 200, headers: {}, data: { id: agent, companyId: company, status: "running" } };
      if (path.includes("/api/heartbeat-runs/")) return { config, status: 200, headers: {}, data: { id: runId, companyId: company, agentId: agent, status: "running", scopeKind: "issue", issueId: source } };
      if (!path.includes("/api/issues/")) return;
      const keys = path.split("/"), id = decodeURIComponent(keys[keys.indexOf("issues") + 1]);
      const key = keys.at(-1);
      const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
      const reply = (data, status = 200) => ({ config, status, headers: {}, data });
      if (path.includes("/documents/")) {
        if (config.method === "put") {
          if (docs.has(key)) return reply({}, 409);
          const doc = { key, companyId: company, issueId: source, format: "markdown", body: body.body, latestRevisionId: "revision", lockedAt: null };
          docs.set(key, doc); return reply(doc, 201);
        }
        return reply(docs.get(key) ?? {}, docs.has(key) ? 200 : 404);
      }
      return reply(id === source ? { id, companyId: company, assigneeAgentId: agent, status: "in_progress", workMode: "standard",
        executionRunId: config.headers?.get?.("X-Paperclip-Run-Id") ?? config.headers?.["X-Paperclip-Run-Id"], checkoutRunId: null } : children.get(id) ?? {});
    },
    observe(config, data) {
      if (!config.url.endsWith("/issues") || config.method !== "post" || typeof data?.id !== "string") return;
      const payload = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
      children.set(data.id, { ...payload, companyId: company, ...data });
    },
  };
}
