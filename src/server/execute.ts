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

function buildPaperclipFallbackPrompt(context: AdapterExecutionContext | JsonObject): string | null {
  const runtimeContext = readPath(context, ["context"]);
  if (!isRecord(runtimeContext)) {
    return null;
  }

  const parts: string[] = [];
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

export function extractPrompt(context: AdapterExecutionContext | JsonObject): string {
  const candidatePaths = [
    ["context", "paperclipTaskMarkdown"],
    ["context", "paperclipIssue", "description"],
    ["context", "paperclipIssue", "title"],
    ["context", "paperclipWakeComment", "body"],
    ["context", "paperclipContinuationSummary", "body"],
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
      return text;
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

export async function execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const options = readOptions(context);
  const config = readOllamaConfig({ ...context.config, ...options });
  const prompt = extractPrompt(context);
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
        output: text,
        text,
        adapter: label,
        adapterType: type,
        model: config.model,
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
