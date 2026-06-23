import { defaultSystemPrompt } from "../metadata.js";

export interface OllamaConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  paperclipBaseUrl: string;
  autoMarkDone: boolean;
  enablePaperclipActions: boolean;
  runtimeSkills: PaperclipRuntimeSkill[];
}

export interface PaperclipRuntimeSkill {
  key: string;
  runtimeName: string;
  source: string;
  sourceStatus?: "available" | "missing";
  missingDetail?: string | null;
  required?: boolean;
  requiredReason?: string | null;
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

function readBoolean(config: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = config[key] ?? process.env[key];
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
      }

      if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
      }
    }
  }

  return fallback;
}

function readRuntimeSkills(config: Record<string, unknown>): PaperclipRuntimeSkill[] {
  const raw = config.paperclipRuntimeSkills;
  if (!Array.isArray(raw)) {
    return [];
  }

  const skills: PaperclipRuntimeSkill[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const key = String(entry.key ?? entry.name ?? "").trim();
    const runtimeName = String(entry.runtimeName ?? entry.name ?? "").trim();
    const source = String(entry.source ?? "").trim();
    if (!key || !runtimeName || !source) continue;

    skills.push({
      key,
      runtimeName,
      source,
      sourceStatus: entry.sourceStatus === "missing" ? "missing" : "available",
      missingDetail: typeof entry.missingDetail === "string" && entry.missingDetail.trim() ? entry.missingDetail.trim() : null,
      required: entry.required === true,
      requiredReason: typeof entry.requiredReason === "string" && entry.requiredReason.trim() ? entry.requiredReason.trim() : null,
    });
  }

  return skills;
}

export function readOllamaConfig(config: Record<string, unknown> = {}): OllamaConfig {
  return {
    baseUrl: readString(config, ["BASE_URL", "baseUrl"], "http://localhost:11434/v1").replace(/\/+$/, ""),
    apiKey: readString(config, ["API_KEY", "apiKey"], "ollama"),
    model: readString(config, ["MODEL", "model"], "qwen2.5-coder:1.5b"),
    temperature: readNumber(config, ["TEMPERATURE", "temperature"], 0.7),
    maxTokens: Math.max(1, Math.floor(readNumber(config, ["MAX_TOKENS", "maxTokens"], 2048))),
    systemPrompt: readString(config, ["SYSTEM_PROMPT", "systemPrompt"], defaultSystemPrompt),
    paperclipBaseUrl: readString(
      config,
      ["PAPERCLIP_BASE_URL", "paperclipBaseUrl"],
      "http://127.0.0.1:3100",
    ).replace(/\/+$/, ""),
    autoMarkDone: readBoolean(config, ["AUTO_MARK_DONE", "autoMarkDone"], true),
    enablePaperclipActions: readBoolean(
      config,
      ["ENABLE_PAPERCLIP_ACTIONS", "enablePaperclipActions"],
      true,
    ),
    runtimeSkills: readRuntimeSkills(config),
  };
}
