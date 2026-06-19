import type { AdapterConfigSchema, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, defaultSystemPrompt, models, type } from "../metadata.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "BASE_URL",
        label: "Ollama Base URL",
        type: "text",
        default: "http://localhost:11434/v1",
        required: true,
        hint: "OpenAI-compatible Ollama endpoint, usually http://localhost:11434/v1.",
      },
      {
        key: "API_KEY",
        label: "API Key",
        type: "text",
        default: "ollama",
        hint: "Ollama's OpenAI-compatible endpoint accepts any non-empty bearer token by default.",
      },
      {
        key: "MODEL",
        label: "Model",
        type: "combobox",
        default: "qwen2.5-coder:1.5b",
        required: true,
        options: models.map((model) => ({ label: model.label, value: model.id })),
        hint: "Pick a known model or type any model name available in Ollama.",
      },
      {
        key: "TEMPERATURE",
        label: "Temperature",
        type: "number",
        default: 0.7,
      },
      {
        key: "MAX_TOKENS",
        label: "Max Tokens",
        type: "number",
        default: 2048,
      },
      {
        key: "SYSTEM_PROMPT",
        label: "System Prompt",
        type: "textarea",
        default: defaultSystemPrompt,
      },
      {
        key: "AUTO_MARK_DONE",
        label: "Auto Mark Done",
        type: "toggle",
        default: true,
        hint: "When enabled, successful one-shot runs mark the touched Paperclip issue done.",
      },
      {
        key: "PAPERCLIP_BASE_URL",
        label: "Paperclip Base URL",
        type: "text",
        default: "http://127.0.0.1:3100",
        hint: "Used only when Auto Mark Done is enabled.",
      },
    ],
  };
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    getConfigSchema,
  };
}
