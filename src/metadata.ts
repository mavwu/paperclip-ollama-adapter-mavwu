import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "ollama_local";

export const label = "Ollama Local";

export const models: AdapterModel[] = [
  { id: "nemotron-3-super:cloud", label: "Nemotron 3 Super Cloud" },
  { id: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B" },
  { id: "llama3.1:8b", label: "Llama 3.1 8B" },
  { id: "codellama:7b", label: "Code Llama 7B" },
  { id: "mistral:7b", label: "Mistral 7B" },
];

export const defaultSystemPrompt =
  "You are a model being used through a Paperclip adapter. Respond only with the final useful answer. Do not mention Paperclip, Ollama, NVIDIA, adapters, identity, reasoning, or internal system details unless the user specifically asks.";

export const agentConfigurationDoc = `# Ollama Local

Use this adapter to run Paperclip agents through Ollama's OpenAI-compatible chat completions endpoint.

## Environment variables

- BASE_URL: Ollama OpenAI-compatible base URL. Defaults to http://localhost:11434/v1
- API_KEY: Authorization bearer token. Defaults to ollama
- MODEL: Any Ollama model name. Defaults to nemotron-3-super:cloud
- TEMPERATURE: Sampling temperature. Defaults to 0.7
- MAX_TOKENS: Maximum output tokens. Defaults to 2048
- SYSTEM_PROMPT: Optional system prompt prepended to each request.

## Paperclip adapter config

The same values can be provided through adapter config using either uppercase keys or camelCase keys:

- BASE_URL or baseUrl
- API_KEY or apiKey
- MODEL or model
- TEMPERATURE or temperature
- MAX_TOKENS or maxTokens
- SYSTEM_PROMPT or systemPrompt
`;
