import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "ollama_local";

export const label = "Ollama Local";

export const models: AdapterModel[] = [
  { id: "qwen2.5-coder:1.5b", label: "Qwen 2.5 Coder 1.5B" },
  { id: "nemotron-3-super:cloud", label: "Nemotron 3 Super Cloud" },
  { id: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B" },
  { id: "llama3.1:8b", label: "Llama 3.1 8B" },
  { id: "codellama:7b", label: "Code Llama 7B" },
  { id: "mistral:7b", label: "Mistral 7B" },
];

export const defaultSystemPrompt =
  [
    "You are operating as the Paperclip agent named in the run context. Stay in that agent role for company, task, and chat interactions, including when the user asks about your role.",
    "Treat the latest user request or wake comment as the current instruction. Use older task, issue, and conversation context only as background unless the latest request explicitly asks you to revisit it.",
    "Be direct, practical, and truthful. Do not claim that you used tools, edited files, ran commands, contacted services, or changed Paperclip state unless the run context or adapter result actually did that.",
    "If the task is simple and complete, give the final answer clearly. If the task cannot be completed from the available context, say what is missing or what is blocked instead of inventing results.",
    "Do not claim to be the underlying model, runtime, adapter, Ollama, or Paperclip internals unless the user specifically asks about implementation details.",
    "Respond with the final useful answer only.",
  ].join(" ");

export const agentConfigurationDoc = `# Ollama Local

Use this adapter to run Paperclip agents through Ollama's OpenAI-compatible chat completions endpoint.

Use for text inference and explicit follow-up task creation. This adapter does not execute tools, hire agents, load skills, or verify task completion. Use a capable agent runtime for autonomous execution.

## Environment variables

- BASE_URL: Model service base URL. Defaults to http://localhost:11434/v1; remote endpoints require HTTPS. URLs cannot include credentials, query strings, or fragments.
- API_KEY: Model-service bearer token only. Omit for the public ollama placeholder; an explicit empty string omits model authorization. Explicit values are treated as secrets, including ollama. Credentials must be visible ASCII without whitespace and are never trimmed or repaired. Never used as Paperclip identity.
- MODEL: Any Ollama model name. Defaults to qwen2.5-coder:1.5b
- TEMPERATURE: Sampling temperature. Defaults to 0.7
- MAX_TOKENS: Maximum output tokens. Defaults to 2048
- MODEL_REQUEST_TIMEOUT_MS: Positive integer request budget, defaults to 120000 ms; maximum 86400000.
- PAPERCLIP_REQUEST_TIMEOUT_MS: Positive integer request budget, defaults to 30000 ms; maximum 86400000.
- EXECUTION_TIMEOUT_MS: Positive integer overall run budget, defaults to 300000 ms; maximum 86400000. A positive trusted TIMEOUT_SEC/timeoutSec additionally caps this budget; zero does not disable it.
- DELEGATION_STORAGE: disabled by default. Set paperclip_documents_v1 only on a verified compatible host after reconciling earlier delegations. Source-issue documents reserve one action and its receipt; uncertain actions are never automatically replayed. Authenticated ownership and a running issue-scoped run are required.
- SYSTEM_PROMPT: Optional system prompt prepended to each request.
- AUTO_MARK_DONE: Deprecated compatibility setting; defaults to false. Issues are never automatically marked done, even when true, because completion is unverified.
- PAPERCLIP_BASE_URL: Optional trusted Paperclip API override for agent lookup and follow-up task creation. Otherwise uses host PAPERCLIP_API_URL, then PAPERCLIP_RUNTIME_API_URL, then host/listen-port derivation (localhost:3100 by default).
- ENABLE_PAPERCLIP_ACTIONS: When true, the adapter can inspect visible agents and create assigned follow-up tasks when asked. Defaults to true.

## Paperclip adapter config

The same values can be provided through adapter config using either uppercase keys or camelCase keys:

Precedence is explicit adapter config, then its host-resolved env object, then process environment, then defaults. Uppercase aliases win conflicts within each layer. Reserved env.PAPERCLIP_API_URL and env.PAPERCLIP_API_KEY cannot replace host runtime URL or context.authToken. Only TEMPERATURE/temperature and MAX_TOKENS/maxTokens may be overridden by task options. Both service clients reject all redirects and ignore ambient Axios authentication/proxy defaults.

When the host supplies the official optional signal/onCancellationReady/onDispatch fields, the adapter registers cancellation readiness before provider work and reports dispatch immediately before its first HTTP request. Older hosts may omit these fields. Cancellation aborts local HTTP work, not verified remote computation or persisted writes. Action receipts distinguish confirmed, rejected, unknown, and not-attempted persistence. Unknown writes must be inspected before retrying. No automatic retries, independent checkout or completion writes are performed. Explicit non-standard work modes do not permit delegation writes. Host callbacks and transports must cooperate and settle; deadlines prevent additional work but cannot forcibly preempt arbitrary host JavaScript.

- BASE_URL or baseUrl
- API_KEY or apiKey
- MODEL or model
- TEMPERATURE or temperature
- MAX_TOKENS or maxTokens
- MODEL_REQUEST_TIMEOUT_MS or modelRequestTimeoutMs
- PAPERCLIP_REQUEST_TIMEOUT_MS or paperclipRequestTimeoutMs
- EXECUTION_TIMEOUT_MS or executionTimeoutMs
- TIMEOUT_SEC or timeoutSec (optional seconds cap)
- DELEGATION_STORAGE or delegationStorage
- SYSTEM_PROMPT or systemPrompt
- AUTO_MARK_DONE or autoMarkDone
- PAPERCLIP_BASE_URL or paperclipBaseUrl
- ENABLE_PAPERCLIP_ACTIONS or enablePaperclipActions
`;
