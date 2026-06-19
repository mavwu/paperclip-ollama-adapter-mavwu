import { defaultSystemPrompt } from "../metadata.js";

export interface OllamaConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
}

function readString(config: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = config[key] ?? process.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return fallback;
}

function readNumber(config: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = config[key] ?? process.env[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return fallback;
}

export function readOllamaConfig(config: Record<string, unknown> = {}): OllamaConfig {
  return {
    baseUrl: readString(config, ["BASE_URL", "baseUrl"], "http://localhost:11434/v1").replace(/\/+$/, ""),
    apiKey: readString(config, ["API_KEY", "apiKey"], "ollama"),
    model: readString(config, ["MODEL", "model"], "nemotron-3-super:cloud"),
    temperature: readNumber(config, ["TEMPERATURE", "temperature"], 0.7),
    maxTokens: Math.max(1, Math.floor(readNumber(config, ["MAX_TOKENS", "maxTokens"], 2048))),
    systemPrompt: readString(config, ["SYSTEM_PROMPT", "systemPrompt"], defaultSystemPrompt),
  };
}
