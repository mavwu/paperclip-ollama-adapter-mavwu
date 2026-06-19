import axios, { AxiosError } from "axios";
import "dotenv/config";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import { label, type } from "../metadata.js";
import { readOllamaConfig } from "./config.js";

type JsonObject = Record<string, unknown>;

interface PaperclipAgentSummary {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string | null;
  reportsTo?: string | null;
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
      if (!Number.isInteger(index)) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function textFromValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

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
      if (text) {
        return text;
      }
    }
  }

  return null;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildAgentIdentityPrompt(context: AdapterExecutionContext | JsonObject): string | null {
  const agentName = textFromValue(readPath(context, ["agent", "name"]));
  if (!agentName) {
    return null;
  }

  return [
    "# Agent identity",
    `You are ${agentName}.`,
    "Answer as this Paperclip agent for company/task interactions.",
  ].join("\n\n");
}

function buildPaperclipFallbackPrompt(context: AdapterExecutionContext | JsonObject): string | null {
  const runtimeContext = readPath(context, ["context"]);
  if (!isRecord(runtimeContext)) {
    return null;
  }

  const parts: string[] = [];
  const agentIdentity = buildAgentIdentityPrompt(context);
  if (agentIdentity) {
    parts.push(agentIdentity);
  }

  const taskMarkdown = textFromValue(runtimeContext.paperclipTaskMarkdown);
  if (taskMarkdown) {
    parts.push(taskMarkdown);
  }

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
    if (body) {
      parts.push(`# Wake comment\n\n${body}`);
    }
  }

  const wakePayload = runtimeContext.paperclipWakePayload;
  if (isRecord(wakePayload)) {
    parts.push(`# Paperclip wake payload\n\n${compactJson(wakePayload)}`);
  }

  const continuationSummary = runtimeContext.paperclipContinuationSummary;
  if (isRecord(continuationSummary)) {
    const title = textFromValue(continuationSummary.title);
    const body = textFromValue(continuationSummary.body);
    if (title || body) {
      parts.push(`# Continuation summary\n\n${[title, body].filter(Boolean).join("\n\n")}`);
    }
  }

  const uniqueParts = [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
  if (uniqueParts.length > 0) {
    return uniqueParts.join("\n\n---\n\n");
  }

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
    if (runtimeContext[key] !== undefined) {
      summary[key] = runtimeContext[key];
    }
  }

  if (Object.keys(summary).length > 0) {
    return `Paperclip run context:\n\n${compactJson(summary)}`;
  }

  return null;
}

function buildWakeCommentPrompt(context: AdapterExecutionContext | JsonObject): string | null {
  const runtimeContext = readPath(context, ["context"]);
  if (!isRecord(runtimeContext)) {
    return null;
  }

  const wakeCommentBody = textFromValue(readPath(runtimeContext, ["paperclipWakeComment", "body"]));
  if (!wakeCommentBody) {
    return null;
  }

  const parts = [
    buildAgentIdentityPrompt(context),
    "",
    "# Current user request",
    wakeCommentBody,
    "",
    "# Existing task context",
    textFromValue(runtimeContext.paperclipTaskMarkdown) ??
      [
        textFromValue(readPath(runtimeContext, ["paperclipIssue", "title"])),
        textFromValue(readPath(runtimeContext, ["paperclipIssue", "description"])),
      ]
        .filter(Boolean)
        .join("\n\n"),
    "",
    "Treat the current user request as the latest instruction. Use the existing task context only as background.",
  ];

  return parts.filter((part) => typeof part === "string" && part.trim()).join("\n\n");
}

export function extractPrompt(context: AdapterExecutionContext | JsonObject): string {
  const wakeCommentPrompt = buildWakeCommentPrompt(context);
  if (wakeCommentPrompt) {
    return wakeCommentPrompt;
  }

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
    if (text) {
      return [buildAgentIdentityPrompt(context), text].filter(Boolean).join("\n\n");
    }
  }

  const contextText = textFromValue((context as AdapterExecutionContext).context);
  if (contextText) {
    return contextText;
  }

  const fallbackPrompt = buildPaperclipFallbackPrompt(context);
  if (fallbackPrompt) {
    return fallbackPrompt;
  }

  return "No explicit prompt was provided. Use the available Paperclip runtime context to provide the most useful concise response.";
}

function extractText(data: unknown): string {
  const candidates = [
    ["choices", "0", "message", "content"],
    ["choices", "0", "message", "reasoning"],
    ["choices", "0", "message", "reasoning_content"],
    ["choices", "0", "text"],
    ["message", "content"],
    ["response"],
  ];

  for (const path of candidates) {
    const value = readPath(data, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "No response generated";
}

function extractUsage(data: unknown): UsageSummary | undefined {
  const usage = readPath(data, ["usage"]);
  if (!isRecord(usage)) {
    return undefined;
  }

  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);

  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) {
    return undefined;
  }

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

function readOptions(context: AdapterExecutionContext): JsonObject {
  const taskOptions = readPath(context, ["context", "task", "options"]);
  const options = readPath(context, ["context", "options"]);

  return {
    ...(isRecord(taskOptions) ? taskOptions : {}),
    ...(isRecord(options) ? options : {}),
  };
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

function paperclipHeaders(context: AdapterExecutionContext): Record<string, string> | null {
  if (!context.authToken) {
    return null;
  }

  return {
    Authorization: `Bearer ${context.authToken}`,
    "Content-Type": "application/json",
  };
}

export function wantsCompanyContext(prompt: string): boolean {
  return /\b(agent|agents|org chart|organization|organisation|company|coworker|team|reports to)\b/i.test(prompt);
}

export function wantsDelegation(prompt: string): boolean {
  return /\b(assign|delegate|forward|handoff|hand off|send (?:it|this|that)?\s*to|ask .+ to|tell .+ to|create (?:a )?(?:task|sub[- ]?task|follow[- ]?up))\b/i.test(prompt);
}

function actionIntentText(prompt: string): string {
  const currentRequest = prompt.match(/# Current user request\s+([\s\S]*?)(?:\n\n# Existing task context|\n\n---|$)/i);
  if (currentRequest?.[1]?.trim()) {
    return currentRequest[1].trim();
  }

  return prompt
    .replace(/# Agent identity[\s\S]*?Answer as this Paperclip agent for company\/task interactions\.\s*/i, "")
    .trim();
}

function normalizeAgent(value: unknown): PaperclipAgentSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = textFromValue(value.id);
  const name = textFromValue(value.name);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    role: textFromValue(value.role),
    title: textFromValue(value.title),
    status: textFromValue(value.status),
    reportsTo: textFromValue(value.reportsTo),
  };
}

async function fetchPaperclipAgents(
  context: AdapterExecutionContext,
  paperclipBaseUrl: string,
): Promise<{ ok: true; agents: PaperclipAgentSummary[] } | { ok: false; error: string }> {
  const companyId = readCompanyId(context);
  const headers = paperclipHeaders(context);
  if (!companyId) {
    return { ok: false, error: "missing_company_id" };
  }

  if (!headers) {
    return { ok: false, error: "missing_auth_token" };
  }

  try {
    const response = await axios.get(`${paperclipBaseUrl}/api/companies/${encodeURIComponent(companyId)}/agents`, {
      headers,
    });
    const agents = Array.isArray(response.data)
      ? response.data.map(normalizeAgent).filter((agent): agent is PaperclipAgentSummary => Boolean(agent))
      : [];
    return { ok: true, agents };
  } catch (error) {
    const axiosError = error as AxiosError<{ error?: string; message?: string }>;
    return {
      ok: false,
      error:
        axiosError.response?.data?.error ??
        axiosError.response?.data?.message ??
        axiosError.message,
    };
  }
}

function describeAgents(agents: PaperclipAgentSummary[]): string {
  if (agents.length === 0) {
    return "No visible agents.";
  }

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
    if (!candidate.trim()) {
      continue;
    }

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
): Promise<DelegationDecision | null> {
  const response = await axios.post(
    `${config.baseUrl}/chat/completions`,
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
            'Return JSON with keys: shouldDelegate boolean, assigneeName string|null, title string|null, description string|null, reason string|null.',
          ].join("\n"),
        },
      ],
      temperature: 0,
      max_tokens: 512,
      stream: false,
    },
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    },
  );

  const parsed = extractJsonObject(extractText(response.data));
  if (!parsed) {
    return null;
  }

  return {
    shouldDelegate: parsed.shouldDelegate === true,
    assigneeName: textFromValue(parsed.assigneeName),
    title: textFromValue(parsed.title),
    description: textFromValue(parsed.description),
    reason: textFromValue(parsed.reason),
  };
}

function findAgentByName(agents: PaperclipAgentSummary[], name: string | null | undefined): PaperclipAgentSummary | null {
  if (!name) {
    return null;
  }

  const normalized = name.trim().toLowerCase();
  const agentMatches = (agent: PaperclipAgentSummary): boolean => {
    const fields = [agent.name, agent.title, agent.role].filter((field): field is string => Boolean(field));
    return fields.some((field) => {
      const value = field.toLowerCase();
      return value === normalized || value.includes(normalized) || normalized.includes(value);
    });
  };

  return (
    agents.find((agent) => agent.name.toLowerCase() === normalized) ??
    agents.find(agentMatches) ??
    null
  );
}

async function preparePaperclipActionContext(
  context: AdapterExecutionContext,
  config: ReturnType<typeof readOllamaConfig>,
  prompt: string,
): Promise<PaperclipActionContext> {
  const intentText = actionIntentText(prompt);
  if (!config.enablePaperclipActions || (!wantsCompanyContext(intentText) && !wantsDelegation(intentText))) {
    return { agents: [], promptAddon: null, actions: [] };
  }

  const agentsResult = await fetchPaperclipAgents(context, config.paperclipBaseUrl);
  if (!agentsResult.ok) {
    return {
      agents: [],
      promptAddon: [
        "# Paperclip company context",
        `The adapter tried to inspect visible agents but could not: ${agentsResult.error}.`,
      ].join("\n\n"),
      actions: [{ type: "fetch_agents", success: false, error: agentsResult.error }],
    };
  }

  return {
    agents: agentsResult.agents,
    promptAddon: buildCompanyContextPrompt(agentsResult.agents),
    actions: [{ type: "fetch_agents", success: true, count: agentsResult.agents.length }],
  };
}

async function maybeCreateDelegatedIssue(
  context: AdapterExecutionContext,
  config: ReturnType<typeof readOllamaConfig>,
  prompt: string,
  agents: PaperclipAgentSummary[],
): Promise<{ text: string; action: JsonObject } | null> {
  if (!config.enablePaperclipActions || !wantsDelegation(actionIntentText(prompt)) || agents.length === 0) {
    return null;
  }

  let decision: DelegationDecision | null = null;
  try {
    decision = await planDelegation(config, prompt, agents);
  } catch (error) {
    return {
      text: "I could not create the delegated task because the delegation planner failed.",
      action: {
        type: "delegate_issue",
        attempted: false,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (!decision?.shouldDelegate) {
    return null;
  }

  const assignee = findAgentByName(agents, decision.assigneeName);
  if (!assignee) {
    return {
      text: `I could not create the delegated task because I could not match "${decision.assigneeName ?? "the requested agent"}" to a visible Paperclip agent.`,
      action: {
        type: "delegate_issue",
        attempted: false,
        success: false,
        reason: "assignee_not_found",
        requestedAssignee: decision.assigneeName ?? null,
      },
    };
  }

  const action = await createDelegatedIssue(context, config.paperclipBaseUrl, assignee, decision);
  if (action.success === true) {
    const identifier = typeof action.identifier === "string" ? ` (${action.identifier})` : "";
    const title = decision.title ? `: ${decision.title}` : "";
    return {
      text: `Created a follow-up task for ${assignee.name}${identifier}${title}.`,
      action: { type: "delegate_issue", ...action },
    };
  }

  return {
    text: `I tried to create a follow-up task for ${assignee.name}, but Paperclip rejected it: ${String(action.error ?? action.reason ?? "unknown error")}.`,
    action: { type: "delegate_issue", ...action },
  };
}

async function createDelegatedIssue(
  context: AdapterExecutionContext,
  paperclipBaseUrl: string,
  assignee: PaperclipAgentSummary,
  decision: DelegationDecision,
): Promise<JsonObject> {
  const companyId = readCompanyId(context);
  const headers = paperclipHeaders(context);
  const parentId = readIssueId(context);
  if (!companyId) {
    return { attempted: false, reason: "missing_company_id" };
  }

  if (!headers) {
    return { attempted: false, reason: "missing_auth_token" };
  }

  try {
    const response = await axios.post(
      `${paperclipBaseUrl}/api/companies/${encodeURIComponent(companyId)}/issues`,
      {
        title: decision.title ?? `Follow up: ${assignee.name}`,
        description: decision.description ?? decision.reason ?? "Follow-up task delegated by the current Paperclip agent.",
        status: "todo",
        parentId,
        assigneeAgentId: assignee.id,
      },
      { headers },
    );

    return {
      attempted: true,
      success: true,
      issueId: isRecord(response.data) ? response.data.id ?? null : null,
      identifier: isRecord(response.data) ? response.data.identifier ?? null : null,
      assigneeAgentId: assignee.id,
      assigneeName: assignee.name,
    };
  } catch (error) {
    const axiosError = error as AxiosError<{ error?: string; message?: string }>;
    return {
      attempted: true,
      success: false,
      status: axiosError.response?.status ?? null,
      assigneeAgentId: assignee.id,
      assigneeName: assignee.name,
      error:
        axiosError.response?.data?.error ??
        axiosError.response?.data?.message ??
        axiosError.message,
    };
  }
}

async function markIssueDone(context: AdapterExecutionContext, paperclipBaseUrl: string, comment: string): Promise<JsonObject> {
  const issueId = readIssueId(context);
  if (!issueId) {
    return { attempted: false, reason: "missing_issue_id" };
  }

  if (!context.authToken) {
    return { attempted: false, reason: "missing_auth_token" };
  }

  try {
    await axios.patch(
      `${paperclipBaseUrl}/api/issues/${encodeURIComponent(issueId)}`,
      {
        status: "done",
        comment,
      },
      {
        headers: {
          Authorization: `Bearer ${context.authToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    return { attempted: true, success: true, issueId, status: "done" };
  } catch (error) {
    const axiosError = error as AxiosError<{ error?: string; message?: string }>;
    return {
      attempted: true,
      success: false,
      issueId,
      status: axiosError.response?.status ?? null,
      error:
        axiosError.response?.data?.error ??
        axiosError.response?.data?.message ??
        axiosError.message,
    };
  }
}

export async function execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const options = readOptions(context);
  const config = readOllamaConfig({ ...context.config, ...options });
  let prompt = extractPrompt(context);
  const paperclipActions = await preparePaperclipActionContext(context, config, prompt);
  if (paperclipActions.promptAddon) {
    prompt = [prompt, "---", paperclipActions.promptAddon].join("\n\n");
  }

  const delegatedIssue = await maybeCreateDelegatedIssue(context, config, prompt, paperclipActions.agents);
  if (delegatedIssue) {
    const autoDisposition = config.autoMarkDone
      ? await markIssueDone(context, config.paperclipBaseUrl, delegatedIssue.text)
      : { attempted: false, reason: "disabled" };
    const actions = [...paperclipActions.actions, delegatedIssue.action];

    await context.onMeta?.({
      adapterType: type,
      command: "paperclip-delegate-issue",
      env: {
        BASE_URL: config.baseUrl,
        MODEL: config.model,
        PAPERCLIP_BASE_URL: config.paperclipBaseUrl,
      },
      prompt,
      context: { provider: "ollama", model: config.model, actions },
    });

    await context.onLog(
      "stdout",
      `[paperclip-ollama-adapter] actions ${JSON.stringify({
        enablePaperclipActions: config.enablePaperclipActions,
        paperclipBaseUrl: config.paperclipBaseUrl,
        actions,
      })}`,
    );
    await context.onLog(
      "stdout",
      `[paperclip-ollama-adapter] disposition ${JSON.stringify({
        autoMarkDone: config.autoMarkDone,
        paperclipBaseUrl: config.paperclipBaseUrl,
        ...autoDisposition,
      })}`,
    );
    await context.onLog("stdout", delegatedIssue.text);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "ollama",
      biller: "ollama",
      model: config.model,
      billingType: "fixed",
      costUsd: 0,
      summary: delegatedIssue.text,
      resultJson: {
        success: true,
        stopReason: "completed",
        summary: delegatedIssue.text,
        result: delegatedIssue.text,
        message: delegatedIssue.text,
        output: delegatedIssue.text,
        text: delegatedIssue.text,
        adapter: label,
        adapterType: type,
        model: config.model,
        disposition: autoDisposition,
        actions,
        usage: null,
      },
      sessionId: context.runtime?.sessionId ?? null,
      sessionParams: context.runtime?.sessionParams ?? null,
      sessionDisplayId: context.runtime?.sessionDisplayId ?? null,
    };
  }

  const messages = [
    ...(config.systemPrompt ? [{ role: "system", content: config.systemPrompt }] : []),
    { role: "user", content: prompt },
  ];

  await context.onMeta?.({
    adapterType: type,
    command: "ollama-openai-chat-completions",
    env: {
      BASE_URL: config.baseUrl,
      MODEL: config.model,
      TEMPERATURE: String(config.temperature),
      MAX_TOKENS: String(config.maxTokens),
    },
    prompt,
    context: { provider: "ollama", model: config.model },
  });

  try {
    const response = await axios.post(
      `${config.baseUrl}/chat/completions`,
      {
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );

    const text = extractText(response.data);
    const autoDisposition = config.autoMarkDone
      ? await markIssueDone(context, config.paperclipBaseUrl, text)
      : { attempted: false, reason: "disabled" };

    await context.onLog(
      "stdout",
      `[paperclip-ollama-adapter] disposition ${JSON.stringify({
        autoMarkDone: config.autoMarkDone,
        paperclipBaseUrl: config.paperclipBaseUrl,
        ...autoDisposition,
      })}`,
    );
    if (paperclipActions.actions.length > 0) {
      await context.onLog(
        "stdout",
        `[paperclip-ollama-adapter] actions ${JSON.stringify({
          enablePaperclipActions: config.enablePaperclipActions,
          paperclipBaseUrl: config.paperclipBaseUrl,
          actions: paperclipActions.actions,
        })}`,
      );
    }

    await context.onLog("stdout", text);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      usage: extractUsage(response.data),
      provider: "ollama",
      biller: "ollama",
      model: config.model,
      billingType: "fixed",
      costUsd: 0,
      summary: text,
      resultJson: {
        success: true,
        stopReason: "completed",
        summary: text,
        result: text,
        message: text,
        output: text,
        text,
        adapter: label,
        adapterType: type,
        model: config.model,
        disposition: autoDisposition,
        actions: paperclipActions.actions,
        usage: extractUsage(response.data) ?? null,
      },
      sessionId: context.runtime?.sessionId ?? null,
      sessionParams: context.runtime?.sessionParams ?? null,
      sessionDisplayId: context.runtime?.sessionDisplayId ?? null,
    };
  } catch (error) {
    const axiosError = error as AxiosError<{ error?: { message?: string }; message?: string }>;
    const status = axiosError.response?.status;
    const errorMessage =
      axiosError.response?.data?.error?.message ??
      axiosError.response?.data?.message ??
      (axiosError.request ? "Unable to connect to Ollama server. Is Ollama running?" : axiosError.message);
    const errorCode = status ? `OLLAMA_ERROR_${status}` : axiosError.request ? "OLLAMA_CONNECTION_ERROR" : "REQUEST_SETUP_ERROR";

    await context.onLog("stderr", `Adapter error [${errorCode}]: ${errorMessage}`);

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage,
      errorCode,
      errorFamily: axiosError.request ? "transient_upstream" : null,
      provider: "ollama",
      biller: "ollama",
      model: config.model,
      billingType: "fixed",
      costUsd: 0,
      summary: null,
      resultJson: {
        success: false,
        error: errorMessage,
        errorCode,
        output: "",
        text: "",
        adapter: label,
        adapterType: type,
        model: config.model,
      },
    };
  }
}
