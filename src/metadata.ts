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

## Environment variables

- BASE_URL: Ollama OpenAI-compatible base URL. Defaults to http://localhost:11434/v1
- API_KEY: Authorization bearer token. Defaults to ollama
- MODEL: Any Ollama model name. Defaults to qwen2.5-coder:1.5b
- TEMPERATURE: Sampling temperature. Defaults to 0.7
- MAX_TOKENS: Maximum output tokens. Defaults to 2048
- SYSTEM_PROMPT: Optional system prompt prepended to each request.
- AUTO_MARK_DONE: When true, successful runs call Paperclip and mark the touched issue done. Defaults to true.
- PAPERCLIP_BASE_URL: Paperclip server URL for AUTO_MARK_DONE. Defaults to http://127.0.0.1:3100
- ENABLE_PAPERCLIP_ACTIONS: When true, the adapter can inspect visible agents and create assigned follow-up tasks when asked. Defaults to true.

## Paperclip adapter config

The same values can be provided through adapter config using either uppercase keys or camelCase keys:

- BASE_URL or baseUrl
- API_KEY or apiKey
- MODEL or model
- TEMPERATURE or temperature
- MAX_TOKENS or maxTokens
- SYSTEM_PROMPT or systemPrompt
- AUTO_MARK_DONE or autoMarkDone
- PAPERCLIP_BASE_URL or paperclipBaseUrl
- ENABLE_PAPERCLIP_ACTIONS or enablePaperclipActions
`;
