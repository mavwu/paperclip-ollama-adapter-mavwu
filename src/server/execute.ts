import "dotenv/config";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import { label, type } from "../metadata.js";
import { ConfigurationError, readOllamaConfig } from "./config.js";
import type { OllamaConfig } from "./config.js";
import { createServiceClients } from "./http.js";
import type { ServiceClients } from "./http.js";
import { WriteRequestError } from "./http.js";
import { ExecutionControl, ExecutionError, executionError, executionErrorCode } from "./lifecycle.js";
import type { LifecycleContext } from "./lifecycle.js";
import { performance } from "node:perf_hooks";
import { openDelegation, readCreationMetadata } from "./delegation.js";
import type { DelegationJournal } from "./delegation.js";
import { ModelResponseError, readResponseText } from "./response.js";
import { collectDiagnosticSecrets, describeError, errorHttpStatus, redactInvocation, redactKnownSecrets, sanitizeDiagnosticText } from "./diagnostics.js";

type JsonObject = Record<string, unknown>;

interface PaperclipAgentSummary {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string | null;
}

interface DelegationDecision {
  shouldDelegate: boolean;
  assigneeName?: string | null;
  title?: string | null;
  description?: string | null;
  reason?: string | null;
}

interface PaperclipActionContext {
  agents: PaperclipAgentSummary[];
  promptAddon: string | null;
  actions: JsonObject[];
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }

    if (!isRecord(current)) return undefined;
    current = current[key];
  }

  return current;
}

function textFromValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();

  if (Array.isArray(value)) {
    const parts = value.map(textFromValue).filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : null;
  }

  if (isRecord(value)) {
    for (const key of [
      "text",
      "content",
      "prompt",
      "input",
      "message",
      "body",
      "title",
      "description",
      "summary",
      "reason",
      "instruction",
    ]) {
      const text = textFromValue(value[key]);
      if (text) return text;
    }
  }

  return null;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildAgentIdentityPrompt(context: AdapterExecutionContext | JsonObject): string | null {
  const agentName = textFromValue(readPath(context, ["agent", "name"]));
  if (!agentName) return null;

  return [
    "# Agent identity",
    `You are ${agentName}.`,
    "Answer as this Paperclip agent for company/task interactions.",
  ].join("\n\n");
}

function buildPaperclipFallbackPrompt(context: AdapterExecutionContext | JsonObject): string | null {
  const runtimeContext = readPath(context, ["context"]);
  if (!isRecord(runtimeContext)) return null;

  const parts: string[] = [];
  const agentIdentity = buildAgentIdentityPrompt(context);
  if (agentIdentity) parts.push(agentIdentity);

  const taskMarkdown = textFromValue(runtimeContext.paperclipTaskMarkdown);
  if (taskMarkdown) parts.push(taskMarkdown);

  const issue = runtimeContext.paperclipIssue;
  if (isRecord(issue)) {
    const identifier = textFromValue(issue.identifier);
    const title = textFromValue(issue.title);
    const description = textFromValue(issue.description);
    parts.push(
      [
        "# Paperclip issue",
        identifier || title ? `Issue: ${[identifier, title].filter(Boolean).join(" - ")}` : null,
        description ? `Description:\n${description}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  const wakeComment = runtimeContext.paperclipWakeComment;
  if (isRecord(wakeComment)) {
    const body = textFromValue(wakeComment.body);
    if (body) parts.push(`# Wake comment\n\n${body}`);
  }

  const wakePayload = runtimeContext.paperclipWakePayload;
  if (isRecord(wakePayload)) parts.push(`# Paperclip wake payload\n\n${compactJson(wakePayload)}`);

  const continuationSummary = runtimeContext.paperclipContinuationSummary;
  if (isRecord(continuationSummary)) {
    const title = textFromValue(continuationSummary.title);
    const body = textFromValue(continuationSummary.body);
    if (title || body) parts.push(`# Continuation summary\n\n${[title, body].filter(Boolean).join("\n\n")}`);
  }

  const uniqueParts = [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
  if (uniqueParts.length > 0) return uniqueParts.join("\n\n---\n\n");

  const contextKeys = [
    "issueId",
    "taskId",
    "taskKey",
    "commentId",
    "wakeCommentId",
    "wakeReason",
    "wakeSource",
    "wakeTriggerDetail",
    "modelProfile",
  ];
  const summary: JsonObject = {};
  for (const key of contextKeys) {
    if (runtimeContext[key] !== undefined) summary[key] = runtimeContext[key];
  }

  return Object.keys(summary).length > 0 ? `Paperclip run context:\n\n${compactJson(summary)}` : null;
}

function buildWakeCommentPrompt(context: AdapterExecutionContext | JsonObject): string | null {
  const runtimeContext = readPath(context, ["context"]);
  if (!isRecord(runtimeContext)) return null;

  const wakeCommentBody = textFromValue(readPath(runtimeContext, ["paperclipWakeComment", "body"]));
  if (!wakeCommentBody) return null;

  const parts = [
    buildAgentIdentityPrompt(context),
    "# Current user request",
    wakeCommentBody,
    "# Existing task context",
    textFromValue(runtimeContext.paperclipTaskMarkdown) ??
      [
        textFromValue(readPath(runtimeContext, ["paperclipIssue", "title"])),
        textFromValue(readPath(runtimeContext, ["paperclipIssue", "description"])),
      ]
        .filter(Boolean)
        .join("\n\n"),
    "Treat the current user request as the latest instruction. Use the existing task context only as background.",
  ];

  return parts.filter((part) => typeof part === "string" && part.trim()).join("\n\n");
}

export function extractPrompt(context: AdapterExecutionContext | JsonObject): string {
  const wakeCommentPrompt = buildWakeCommentPrompt(context);
  if (wakeCommentPrompt) return wakeCommentPrompt;

  const candidatePaths = [
    ["context", "paperclipWakeComment", "body"],
    ["context", "paperclipContinuationSummary", "body"],
    ["context", "paperclipIssue", "description"],
    ["context", "paperclipIssue", "title"],
    ["context", "paperclipTaskMarkdown"],
    ["prompt"],
    ["input"],
    ["message"],
    ["task", "prompt"],
    ["task", "input"],
    ["runtime", "prompt"],
    ["runtime", "input"],
    ["agent", "prompt"],
    ["context", "prompt"],
    ["context", "input"],
    ["context", "message"],
    ["context", "task", "prompt"],
    ["context", "task", "input"],
    ["context", "runtime", "prompt"],
    ["context", "runtime", "input"],
    ["context", "agent", "prompt"],
  ];

  for (const path of candidatePaths) {
    const text = textFromValue(readPath(context, path));
    if (text) return [buildAgentIdentityPrompt(context), text].filter(Boolean).join("\n\n");
  }

  const contextText = textFromValue((context as AdapterExecutionContext).context);
  if (contextText) return contextText;

  return (
    buildPaperclipFallbackPrompt(context) ??
    "No explicit prompt was provided. Use the available Paperclip runtime context to provide the most useful concise response."
  );
}

function extractUsage(data: unknown): UsageSummary | undefined {
  const usage = readPath(data, ["usage"]);
  if (!isRecord(usage)) return undefined;

  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return undefined;

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

function readOptions(context: AdapterExecutionContext): JsonObject[] {
  const taskOptions = readPath(context, ["context", "task", "options"]);
  const options = readPath(context, ["context", "options"]);

  return [isRecord(taskOptions) ? taskOptions : {}, isRecord(options) ? options : {}];
}

function readIssueId(context: AdapterExecutionContext): string | null {
  const value = readPath(context, ["context", "paperclipIssue", "id"]) ?? readPath(context, ["context", "issueId"]);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readCompanyId(context: AdapterExecutionContext): string | null {
  const value =
    readPath(context, ["agent", "companyId"]) ??
    readPath(context, ["context", "paperclipIssue", "companyId"]) ??
    readPath(context, ["context", "companyId"]);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function wantsCompanyContext(prompt: string): boolean {
  return requiresCompanyContext(prompt) || /\b(?:our|my|this|your)\s+(?:company|organi[sz]ation|team|agents?|coworkers?)\b/i.test(prompt);
}

function requiresCompanyContext(prompt: string): boolean {
  // Organizational data requests, rather than generic words such as "agent".
  const ownedOrganization = /\b(?:our|my|this|your|the)\s+(?:paperclip\s+)?(?:company|organi[sz]ation|team|agents?|coworkers?)\b/i.test(prompt);
  const dataQuestion = /\b(?:who|which|what|how many|list|show|fetch|get|inspect|check|look up|read|status|roster|describe|summari[sz]e)\b/i.test(prompt);
  return (ownedOrganization && dataQuestion) ||
    /\b(?:our|my|company|paperclip)\s+(?:org|organi[sz]ation)\s+chart\b/i.test(prompt) ||
    /\b(?:show|check|fetch|get|inspect)\s+(?:the\s+)?org\s+chart\b/i.test(prompt) ||
    /\bwho\s+reports\s+to\b/i.test(prompt) ||
    /\bwho\s+(?:is|are)\s+(?:our|my|the|your)\s+(?:ceo|cto|cfo|coo|manager|developer|engineer)\b/i.test(prompt) ||
    /\b(?:who|which|what)\s+(?:are|is)\s+(?:the\s+)?(?:available|visible)\s+agents?\b/i.test(prompt) ||
    /\b(?:list|show|fetch|get|inspect|check)\s+(?:(?:all|the|available|visible|company|paperclip)\s+)*agents?\b/i.test(prompt) ||
    /\b(?:authenticated\s+paperclip\s+data|paperclip\s+(?:data|agents?|roster|org\s+chart))\b/i.test(prompt);
}

export function wantsDelegation(prompt: string): boolean {
  return /\b(assign|delegate|forward|handoff|hand off|send (?:it|this|that)?\s*to|ask .+ to|tell .+ to|create (?:a )?(?:task|sub[- ]?task|follow[- ]?up))\b/i.test(prompt);
}

function actionRequest(context: AdapterExecutionContext): string {
  // Read source fields before rendering identity, history or company instructions.
  // Markdown headings inside model-visible text are not a trusted intent boundary.
  const paths = [
    ["context", "paperclipWakeComment", "body"],
    ["context", "prompt"], ["context", "input"], ["context", "message"],
    ["context", "task", "prompt"], ["context", "task", "input"],
    ["prompt"], ["input"], ["message"], ["task", "prompt"], ["task", "input"],
    ["runtime", "prompt"], ["runtime", "input"], ["agent", "prompt"],
    ["context", "runtime", "prompt"], ["context", "runtime", "input"], ["context", "agent", "prompt"],
    ["context", "paperclipIssue", "description"], ["context", "paperclipIssue", "title"],
    ["context", "paperclipTaskMarkdown"],
  ];
  for (const path of paths) {
    const value = readPath(context, path);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeAgent(value: unknown): PaperclipAgentSummary | null {
  if (!isRecord(value)) return null;

  const id = textFromValue(value.id);
  const name = textFromValue(value.name);
  if (!id || !name) return null;

  return {
    id,
    name,
    role: textFromValue(value.role),
    title: textFromValue(value.title),
    status: textFromValue(value.status),
  };
}

async function fetchPaperclipAgents(
  context: AdapterExecutionContext,
  clients: ServiceClients,
  secrets: readonly string[],
): Promise<{ ok: true; agents: PaperclipAgentSummary[] } | { ok: false; error: string; errorCode?: string }> {
  const companyId = readCompanyId(context);
  if (!companyId) return { ok: false, error: "missing_company_id" };
  if (!context.authToken) return { ok: false, error: "missing_auth_token" };

  try {
    const response = await clients.listAgents(companyId);
    if (!Array.isArray(response.data)) return { ok: false, error: "invalid_agents_response" };
    const agents = response.data.map(normalizeAgent).filter((agent): agent is PaperclipAgentSummary => Boolean(agent));
    return { ok: true, agents };
  } catch (error) {
    const interruption = executionError(error);
    if (interruption && interruption.code !== "PAPERCLIP_REQUEST_TIMEOUT") throw interruption;
    return {
      ok: false,
      error: describeError(error, secrets),
      ...(interruption ? { errorCode: interruption.code } : {}),
    };
  }
}

function describeAgents(agents: PaperclipAgentSummary[]): string {
  if (agents.length === 0) return "No visible agents.";

  return agents
    .map((agent) =>
      [
        `- ${agent.name}`,
        agent.title ? `title: ${agent.title}` : null,
        agent.role ? `role: ${agent.role}` : null,
        agent.status ? `status: ${agent.status}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
}

function buildCompanyContextPrompt(agents: PaperclipAgentSummary[]): string {
  return [
    "# Available Paperclip agents",
    describeAgents(agents),
    "",
    "Use this company context when the request asks about agents, the org chart, assignment, delegation, or forwarding work.",
    "If you create or claim a task handoff, rely on the adapter action result instead of inventing Paperclip state.",
  ].join("\n");
}

function extractJsonObject(text: string): JsonObject | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""),
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
  ];

  for (const candidate of candidates) {
    if (!candidate.trim()) continue;

    try {
      const parsed = JSON.parse(candidate);
      return isRecord(parsed) ? parsed : null;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

async function planDelegation(
  config: ReturnType<typeof readOllamaConfig>,
  prompt: string,
  agents: PaperclipAgentSummary[],
  clients: ServiceClients,
): Promise<DelegationDecision> {
  const response = await clients.complete(
    {
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            "Return only compact JSON. Decide whether this Paperclip request should create an assigned follow-up task for another visible agent.",
        },
        {
          role: "user",
          content: [
            "Current request:",
            prompt,
            "",
            "Visible agents:",
            describeAgents(agents),
            "",
            "Return JSON with keys: shouldDelegate boolean, assigneeName string|null, title string|null, description string|null, reason string|null.",
          ].join("\n"),
        },
      ],
      temperature: 0,
      max_tokens: 512,
      stream: false,
    },
  );

  const parsed = extractJsonObject(readResponseText(response.data));
  if (!parsed || typeof parsed.shouldDelegate !== "boolean") throw new Error("Invalid delegation plan: expected a boolean shouldDelegate.");
  for (const key of ["assigneeName", "title", "description", "reason"]) {
    if (parsed[key] !== undefined && parsed[key] !== null && typeof parsed[key] !== "string") {
      throw new Error(`Invalid delegation plan: ${key} must be text or null.`);
    }
  }

  return {
    shouldDelegate: parsed.shouldDelegate,
    assigneeName: textFromValue(parsed.assigneeName),
    title: textFromValue(parsed.title),
    description: textFromValue(parsed.description),
    reason: textFromValue(parsed.reason),
  };
}

function findAgentByName(
  agents: PaperclipAgentSummary[], name: string | null | undefined, currentAgentId: string,
): { agent?: PaperclipAgentSummary; reason?: string } {
  if (!name) return { reason: "assignee_not_found" };

  const normalized = name.trim().toLowerCase();
  const agentMatches = (agent: PaperclipAgentSummary): boolean => {
    const fields = [agent.name, agent.title, agent.role].filter((field): field is string => Boolean(field));
    return fields.some((field) => {
      const value = field.toLowerCase();
      return value === normalized;
    });
  };

  const named = agents.filter((agent) => agent.name.toLowerCase() === normalized);
  const matches = named.length > 0 ? named : agents.filter(agentMatches);
  if (matches.length === 0) return { reason: "assignee_not_found" };
  if (matches.length !== 1) return { reason: "assignee_ambiguous" };
  const agent = matches[0];
  if (agent.id === currentAgentId || !["idle", "active", "running"].includes(agent.status ?? "")) {
    return { reason: "assignee_ineligible" };
  }
  return { agent };
}

async function preparePaperclipActionContext(
  context: AdapterExecutionContext,
  config: ReturnType<typeof readOllamaConfig>,
  prompt: string,
  secrets: readonly string[],
  clients: ServiceClients,
): Promise<PaperclipActionContext> {
  if (!config.enablePaperclipActions || (!wantsCompanyContext(prompt) && !wantsDelegation(prompt))) {
    return { agents: [], promptAddon: null, actions: [] };
  }

  const required = requiresCompanyContext(prompt) || wantsDelegation(prompt);
  const agentsResult = await fetchPaperclipAgents(context, clients, secrets);
  if (!agentsResult.ok) {
    return {
      agents: [],
      promptAddon: [
        "# Paperclip company context",
        "Authenticated company context is unavailable. Answer only the general part of the request; do not invent internal company facts or claim organizational actions.",
      ].join("\n\n"),
      actions: [{ type: "fetch_agents", success: false, required, error: agentsResult.error, ...(agentsResult.errorCode ? { errorCode: agentsResult.errorCode } : {}) }],
    };
  }

  return {
    agents: agentsResult.agents,
    promptAddon: buildCompanyContextPrompt(agentsResult.agents),
    actions: [{ type: "fetch_agents", success: true, required, count: agentsResult.agents.length }],
  };
}

function validReceiptId(value: unknown, secrets: readonly string[]): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value === value.trim() &&
    !/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) &&
    redactKnownSecrets(value, secrets) === value;
}

async function createDelegatedIssue(
  context: AdapterExecutionContext,
  clients: ServiceClients,
  assignee: PaperclipAgentSummary,
  decision: DelegationDecision,
  secrets: readonly string[],
  journal: DelegationJournal,
): Promise<JsonObject> {
  const companyId = readCompanyId(context);
  if (!companyId) return { attempted: false, success: false, reason: "missing_company_id" };
  if (!context.authToken) return { attempted: false, success: false, reason: "missing_auth_token" };
  if (!validReceiptId(assignee.id, secrets)) return { attempted: false, success: false, reason: "invalid_assignee_id", error: "The selected agent did not supply a safe scalar ID. No task was created." };

  try {
    const reserved = await journal.reserve(
      decision.title ?? `Follow up: ${assignee.name}`,
      decision.description ?? decision.reason ?? "Follow-up task delegated by the current Paperclip agent.", assignee.id);
    if (!reserved.payload) return reserved.action!;
    const response = await clients.createIssue(
      companyId,
      reserved.payload,
    );
    const interrupted = response.interruption ? { errorCode: response.interruption.code } : {};
    const creation = readCreationMetadata(response.status, response.data);

    // Required identity is an opaque, nonblank scalar, never arbitrary JSON.
    // Do not normalize IDs or copy unvalidated optional provider fields.
    if (!isRecord(response.data) || !validReceiptId(response.data.id, secrets) || response.data.id === readIssueId(context)) {
      return { attempted: true, success: false, persistence: "unknown", ...interrupted, reason: "invalid_issue_receipt", error: "Paperclip returned no safe scalar issue ID; creation outcome is unverified. Do not retry blindly." };
    }
    // Legacy receipts may omit the assignment echo. Any supplied value must be
    // a matching string; null, objects and mismatches cannot confirm assignment.
    if (response.data.assigneeAgentId !== undefined &&
        (typeof response.data.assigneeAgentId !== "string" || response.data.assigneeAgentId !== assignee.id)) {
      return await journal.record({
        attempted: true, success: false, persistence: "confirmed", ...interrupted, ...(creation ?? { creationOutcome: "unknown" }), issueId: response.data.id, reason: "assignment_not_verified",
        error: "The returned issue is not assigned to the requested agent. Check Paperclip state before retrying.",
      });
    }
    if (!creation) {
      return await journal.record({ attempted: true, success: false, persistence: "confirmed", ...interrupted, issueId: response.data.id,
        creationOutcome: "unknown", reason: "invalid_creation_metadata", error: "Paperclip returned malformed or contradictory creation diagnostics. Inspect the returned issue before retrying." });
    }
    const rawIdentifier = response.data.identifier;
    const identifier = typeof rawIdentifier === "string" && rawIdentifier.trim() && rawIdentifier.length <= 512 &&
      !/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(rawIdentifier)
      ? redactKnownSecrets(rawIdentifier.trim(), secrets) : null;
    return await journal.record({
      attempted: true,
      success: true,
      persistence: "confirmed",
      ...creation,
      ...interrupted,
      issueId: response.data.id,
      identifier,
      assigneeAgentId: assignee.id,
      assigneeName: redactKnownSecrets(assignee.name, secrets),
    });
  } catch (error) {
    const writeFailure = error instanceof WriteRequestError ? error : undefined;
    const interruption = writeFailure?.interruption ?? executionError(error);
    return {
      attempted: writeFailure?.attempted ?? !interruption,
      success: false,
      persistence: writeFailure?.persistence ?? (interruption ? "not_attempted" : "unknown"),
      ...(interruption ? { errorCode: interruption.code } : {}),
      status: errorHttpStatus(error) ?? null,
      assigneeAgentId: assignee.id,
      assigneeName: sanitizeDiagnosticText(assignee.name, secrets),
      error: describeError(error, secrets),
    };
  }
}

async function maybeCreateDelegatedIssue(
  context: AdapterExecutionContext,
  config: ReturnType<typeof readOllamaConfig>,
  prompt: string,
  agents: PaperclipAgentSummary[],
  secrets: readonly string[],
  clients: ServiceClients,
  journal?: DelegationJournal,
): Promise<{ text: string; action: JsonObject } | null> {
  if (!config.enablePaperclipActions || !wantsDelegation(prompt)) return null;
  if (!journal) throw new Error("Delegation requires a verified durable reservation boundary.");
  if (agents.length === 0) {
    return { text: "I could not delegate because no visible agents were available.", action: { type: "delegate_issue", attempted: false, success: false, reason: "no_visible_agents" } };
  }

  let decision: DelegationDecision | null = null;
  try {
    decision = await planDelegation(config, prompt, agents, clients);
  } catch (error) {
    if (executionError(error)) throw error;
    return {
      text: "I could not create the delegated task because the delegation planner failed.",
      action: {
        type: "delegate_issue",
        attempted: false,
        success: false,
        error: describeError(error, secrets),
      },
    };
  }

  if (!decision.shouldDelegate) {
    return { text: "The planner did not approve the requested delegation; no task was created.", action: { type: "delegate_issue", attempted: false, success: false, reason: "delegation_declined" } };
  }

  const { agent: assignee, reason } = findAgentByName(agents, decision.assigneeName, context.agent.id);
  if (!assignee) {
    const requestedAssignee = sanitizeDiagnosticText(decision.assigneeName ?? "the requested agent", secrets);
    return {
      text: `I could not create the delegated task for "${requestedAssignee}": ${reason}.`,
      action: {
        type: "delegate_issue",
        attempted: false,
        success: false,
        reason,
        requestedAssignee,
      },
    };
  }

  const action = await createDelegatedIssue(context, clients, assignee, decision, secrets, journal);
  if (action.success === true) {
    const identifier = typeof action.identifier === "string" ? ` (${action.identifier})` : "";
    const title = decision.title ? `: ${decision.title}` : "";
    return {
      text: `${action.creationOutcome === "created" ? "Created a follow-up task" : action.creationOutcome === "reused" ? "Reused existing follow-up task" : "Confirmed a follow-up task"} for ${assignee.name}${identifier}${title}.`,
      action: { type: "delegate_issue", ...action },
    };
  }

  return {
    text: `I could not confirm a follow-up task for ${assignee.name}: ${String(action.error ?? action.reason ?? "unknown error")}.${action.persistence === "unknown" ? " Issue creation may have persisted; inspect Paperclip state before retrying." : ""} No automatic retry was performed.`,
    action: { type: "delegate_issue", ...action },
  };
}

function executionResult(
  context: AdapterExecutionContext,
  config: Pick<OllamaConfig, "model" | "autoMarkDone">,
  text: string,
  outcome: "response_received" | "delegated" | "failed" | "cancelled" | "timed_out",
  actions: JsonObject[],
  usage?: UsageSummary,
  errorCode?: string,
): AdapterExecutionResult {
  const success = outcome === "response_received" || outcome === "delegated";
  return {
    exitCode: success ? 0 : 1,
    signal: null,
    timedOut: outcome === "timed_out",
    ...(success ? {} : { errorMessage: text, errorCode }),
    usage,
    provider: "ollama",
    biller: "ollama",
    model: config.model,
    billingType: "fixed",
    costUsd: 0,
    summary: text,
    resultJson: {
      success,
      stopReason: outcome,
      ...(outcome === "cancelled" ? { status: "cancelled" } : {}),
      // A generated answer or created child is not evidence that the source task is complete.
      workflowCompleted: false,
      ...(success ? {} : { error: text, errorCode }),
      summary: text,
      result: text,
      message: text,
      output: text,
      text,
      adapter: label,
      adapterType: type,
      model: config.model,
      disposition: { attempted: false, reason: config.autoMarkDone ? "completion_not_verified" : "disabled" },
      actions,
      usage: usage ?? null,
    },
    sessionId: context.runtime?.sessionId ?? null,
    sessionParams: context.runtime?.sessionParams ?? null,
    sessionDisplayId: context.runtime?.sessionDisplayId ?? null,
  };
}

export async function execute(context: LifecycleContext): Promise<AdapterExecutionResult> {
  const startedAt = performance.now();
  let control: ExecutionControl | undefined;
  let config: OllamaConfig | undefined;
  const unconfigured = { model: "unconfigured", autoMarkDone: false };
  const request = actionRequest(context);
  const secrets = collectDiagnosticSecrets(process.env, context.config, readOptions(context), { authToken: context.authToken });
  const actions: JsonObject[] = [];
  const log: AdapterExecutionContext["onLog"] = async (stream, text) => { control?.check(); await context.onLog(stream, redactKnownSecrets(text, secrets)); control?.check(); };
  const meta: AdapterExecutionContext["onMeta"] = async value => { control?.check(); await context.onMeta?.(redactInvocation(value, secrets)); control?.check(); };
  let usage: UsageSummary | undefined;
  let requestingModel = false;
  const stoppedResult = (interruption: ExecutionError) => {
    const writeNote = actions.some(action => action.persistence === "unknown")
      ? " Issue creation may have persisted; its outcome is unverified. Inspect Paperclip state before retrying."
      : actions.some(action => action.persistence === "confirmed") ? " A prior issue-creation receipt is preserved; stopping this run does not undo that write." : "";
    return executionResult(context, config ?? unconfigured, interruption.message + writeNote,
      interruption.code === "cancelled" ? "cancelled" : interruption.timedOut ? "timed_out" : "failed", actions, usage, interruption.code);
  };
  const finish = async (text: string, outcome: "response_received" | "delegated" | "failed", errorCode?: string) => {
    control?.check();
    const stoppedCode = executionErrorCode(errorCode);
    if (stoppedCode) throw new ExecutionError(stoppedCode);
    text = redactKnownSecrets(text, secrets);
    if (outcome === "failed") text = sanitizeDiagnosticText(text, secrets);
    const result = executionResult(context, config ?? unconfigured, text, outcome, actions, usage, errorCode);
    if (actions.length > 0) await log("stdout", `[paperclip-ollama-adapter] actions ${JSON.stringify({ actions })}`);
    await log("stdout", `[paperclip-ollama-adapter] disposition ${JSON.stringify(result.resultJson?.disposition)}`);
    await log(outcome === "failed" ? "stderr" : "stdout", text);
    control?.check();
    return result;
  };

  try {
    config = readOllamaConfig(context.config, readOptions(context));
    control = new ExecutionControl(context, config.executionTimeoutMs, startedAt);
    // Secrets come from supplied config/environment/token values above. The
    // implicit public "ollama" placeholder is not a secret; explicit keys are.
    const clients = createServiceClients(config, context.authToken, undefined, control, context.runId);
    await control.ready();
    let prompt = extractPrompt(context);
    const required = requiresCompanyContext(request) || wantsDelegation(request);
    const workMode = readPath(context, ["context", "paperclipIssue", "workMode"]);
    const jwtScope = readPath(context, ["context", "paperclipAgentJwtScope", "kind"]);
    if (wantsDelegation(request) && ((workMode !== undefined && workMode !== "standard") || jwtScope === "skill_test")) {
      actions.push({ type: "delegate_issue", attempted: false, success: false, persistence: "not_attempted", reason: "work_mode_unsupported" });
      return await finish("This work mode does not permit this adapter to create delegated tasks. No task was created.", "failed", "PAPERCLIP_WORK_MODE_UNSUPPORTED");
    }
    if (!config.enablePaperclipActions && required) {
      actions.push({ type: wantsDelegation(request) ? "delegate_issue" : "fetch_agents", attempted: false, success: false, required: true, reason: "actions_disabled" });
      return await finish("The requested organizational operation requires Paperclip actions, which are disabled. No action was performed.", "failed", "PAPERCLIP_ACTIONS_DISABLED");
    }
    let journal: DelegationJournal | undefined;
    if (wantsDelegation(request)) {
      const opened = await openDelegation({ storage: config.delegationStorage, companyId: readCompanyId(context), sourceIssueId: readIssueId(context),
        agentId: context.agent.id, runId: context.runId, request, serviceIdentity: config.paperclipBaseUrl }, clients, secrets, control);
      journal = opened.journal;
      if (opened.action) {
        actions.push(opened.action);
        control.check();
        const stopCode = executionErrorCode(opened.action.errorCode);
        if (stopCode) throw new ExecutionError(stopCode);
        return await finish(opened.action.success === true ? "Verified the existing delegated task. No new issue was created." :
          "Delegation requires review: the source ownership or durable action record could not authorize a new creation. No issue-creation request was started.",
        opened.action.success === true ? "delegated" : "failed", opened.action.success === true ? undefined : "PAPERCLIP_DELEGATION_BLOCKED");
      }
    }
    const paperclipActions = await preparePaperclipActionContext(context, config, request, secrets, clients);
    actions.push(...paperclipActions.actions);
    if (actions.some(action => action.success === false && action.required === true)) {
      const delegation = wantsDelegation(request);
      return await finish(
        `Paperclip agent lookup failed: ${String(actions[0].error)}. No task was created.`,
        "failed", typeof actions[0].errorCode === "string" ? actions[0].errorCode : delegation ? "PAPERCLIP_DELEGATION_FAILED" : "PAPERCLIP_CONTEXT_FAILED",
      );
    }
    if (paperclipActions.promptAddon) prompt = [prompt, "---", paperclipActions.promptAddon].join("\n\n");

    // Only the original source request is used for action detection and planning.
    const delegatedIssue = await maybeCreateDelegatedIssue(context, config, request, paperclipActions.agents, secrets, clients, journal);
    if (delegatedIssue) {
      actions.push(delegatedIssue.action);
      control.check();
      const stopCode = executionErrorCode(delegatedIssue.action.errorCode);
      if (stopCode) throw new ExecutionError(stopCode);
      await meta({
        adapterType: type,
        command: "paperclip-delegate-issue",
        env: { BASE_URL: sanitizeDiagnosticText(config.baseUrl, secrets), MODEL: config.model, PAPERCLIP_BASE_URL: sanitizeDiagnosticText(config.paperclipBaseUrl, secrets) },
        prompt,
        context: { provider: "ollama", model: config.model, actions },
      });
      return await finish(delegatedIssue.text, delegatedIssue.action.success === true ? "delegated" : "failed",
        delegatedIssue.action.success === true ? undefined : "PAPERCLIP_DELEGATION_FAILED");
    }

    await meta({
      adapterType: type,
      command: "ollama-openai-chat-completions",
      env: { BASE_URL: sanitizeDiagnosticText(config.baseUrl, secrets), MODEL: config.model, TEMPERATURE: String(config.temperature), MAX_TOKENS: String(config.maxTokens) },
      prompt,
      context: { provider: "ollama", model: config.model },
    });
    requestingModel = true;
    const response = await clients.complete(
      {
        model: config.model,
        messages: [
          ...(config.systemPrompt ? [{ role: "system", content: config.systemPrompt }] : []),
          { role: "user", content: prompt },
        ],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: false,
      },
    );
    requestingModel = false;
    usage = extractUsage(response.data);
    return await finish(readResponseText(response.data), "response_received");
  } catch (error) {
    let stoppedBeforeSetup = false;
    try { stoppedBeforeSetup = !control && context.signal?.aborted === true; } catch { /* malformed host signal */ }
    const interruption = control?.error ?? (stoppedBeforeSetup ? new ExecutionError("cancelled") : executionError(error));
    if (interruption) {
      // Preserve receipts, but never wait for more logging/metadata after a stop.
      return stoppedResult(interruption);
    }
    const status = errorHttpStatus(error);
    let invalidConfiguration = false;
    try { invalidConfiguration = error instanceof ConfigurationError; } catch { /* hostile error object */ }
    const errorCode = invalidConfiguration ? "INVALID_CONFIGURATION" : ModelResponseError.codeOf(error) ??
      (requestingModel ? status ? `OLLAMA_ERROR_${status}` : "OLLAMA_CONNECTION_ERROR" : "ADAPTER_EXECUTION_FAILED");
    const text = describeError(error, secrets);
    // Logging failure must not erase the structured failure (or receipts of earlier writes).
    try { await log("stderr", `Adapter error [${errorCode}]: ${text}`); } catch { /* result remains authoritative */ }
    if (control?.error) return stoppedResult(control.error);
    return executionResult(context, config ?? unconfigured, text, "failed", actions, usage, errorCode);
  } finally {
    control?.dispose();
  }
}
