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
        hint: "Omit for the public Ollama placeholder; empty disables model authorization. Explicit keys are treated as secrets. Credentials must be visible ASCII without whitespace.",
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
        key: "MODEL_REQUEST_TIMEOUT_MS", label: "Model request deadline (ms)", type: "number",
        hint: "Positive integer, at most 86400000. Omit for 120000 ms. Task options cannot override this deadline.",
      },
      {
        key: "PAPERCLIP_REQUEST_TIMEOUT_MS", label: "Paperclip request deadline (ms)", type: "number",
        hint: "Positive integer, at most 86400000. Omit for 30000 ms. Optional lookup timeouts do not prevent general inference.",
      },
      {
        key: "EXECUTION_TIMEOUT_MS", label: "Overall execution deadline (ms)", type: "number",
        hint: "Positive integer, at most 86400000. Omit for 300000 ms. Covers all requests and gates additional work.",
      },
      {
        key: "timeoutSec", label: "Host timeout cap (seconds)", type: "number",
        hint: "Optional trusted cap on the overall budget. Zero leaves the adapter's bounded deadline active.",
      },
      {
        key: "SYSTEM_PROMPT",
        label: "System Prompt",
        type: "textarea",
        default: defaultSystemPrompt,
      },
      {
        key: "AUTO_MARK_DONE",
        label: "Auto Mark Done (deprecated)",
        type: "toggle",
        default: false,
        hint: "Accepted for compatibility only. One-shot responses cannot verify task completion; issues remain open even when enabled.",
      },
      {
        key: "ENABLE_PAPERCLIP_ACTIONS",
        label: "Paperclip Actions",
        type: "toggle",
        default: true,
        hint: "Allow the adapter to inspect agents and create assigned follow-up tasks when asked.",
      },
      {
        key: "DELEGATION_STORAGE", label: "Delegation safety storage", type: "select",
        options: [{ label: "Disabled (default)", value: "disabled" }, { label: "Verified Paperclip documents v1", value: "paperclip_documents_v1" }],
        hint: "Enable only after verifying the server contract and reconciling earlier delegations. Reserves one durable action per source issue; unresolved actions require review.",
      },
      {
        key: "PAPERCLIP_BASE_URL",
        label: "Paperclip Base URL",
        type: "text",
        hint: "Optional trusted override. Omit to use the host runtime API URL. HTTPS is required except for loopback HTTP.",
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
