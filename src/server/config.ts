import { defaultSystemPrompt } from "../metadata.js";
import { isIP } from "node:net";

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

export class ConfigurationError extends Error {
  readonly code = "INVALID_CONFIGURATION";
  constructor(field: string) {
    // Never echo invalid values: URLs and credentials may contain secrets.
    super(`Invalid ${field} configuration. Check the configured value.`);
    this.name = "ConfigurationError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function selected(layers: Record<string, unknown>[], keys: string[], fallback: unknown): unknown {
  for (const layer of layers) {
    for (const key of keys) {
      if (Object.hasOwn(layer, key) && layer[key] !== undefined) return layer[key];
    }
  }
  return fallback;
}

function stringValue(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new ConfigurationError(field);
  return value.trim();
}

function numberValue(value: unknown, field: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) throw new ConfigurationError(field);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConfigurationError(field);
  if (field === "TEMPERATURE" && (parsed < 0 || parsed > 2)) throw new ConfigurationError(field);
  if (field === "MAX_TOKENS" && (!Number.isSafeInteger(parsed) || parsed < 1)) throw new ConfigurationError(field);
  return parsed;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
  }
  throw new ConfigurationError(field);
}

export function validateBearerCredential(value: unknown, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  // Visible ASCII survives Axios/Node header serialization unchanged. Never trim
  // or repair credentials: doing so changes identity and defeats exact redaction.
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value)) throw new ConfigurationError(field);
  return value;
}

export function validateEndpoint(value: unknown, field: string): string {
  const raw = stringValue(value, field);
  // WHATWG parsing repairs excess slashes and erases empty user-info. Require a
  // nonempty raw authority before allowing any such normalization.
  const authority = /^https?:\/\/([^/?#\\]*)/i.exec(raw)?.[1];
  if (!authority || authority.includes("@") || /[\s\\\u0000-\u001f\u007f?#]/.test(raw)) throw new ConfigurationError(field);
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConfigurationError(field); }
  if (url.username || url.password || !url.hostname) throw new ConfigurationError(field);
  const ipv4Loopback = isIP(url.hostname) === 4 && url.hostname.split(".")[0] === "127";
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || ipv4Loopback;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new ConfigurationError(field);
  return url.href.replace(/\/+$/, "");
}

// Match current upstream buildPaperclipEnv, without importing unrelated process
// execution helpers. Runtime URLs belong to the host, never context/task data.
function runtimeApiUrl(): unknown {
  for (const key of ["PAPERCLIP_API_URL", "PAPERCLIP_RUNTIME_API_URL"]) {
    if (process.env[key] !== undefined) return process.env[key];
  }
  let host = process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost";
  host = host.trim();
  if (!host || host === "0.0.0.0" || host === "::") host = "localhost";
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) host = `[${host}]`;
  return `http://${host}:${process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100"}`;
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

export function readOllamaConfig(config: Record<string, unknown> = {}, taskOverrides: readonly unknown[] = []): OllamaConfig {
  const layers = [config, record(config.env), process.env];
  const choose = (keys: string[], fallback: unknown) => selected(layers, keys, fallback);
  let temperature = numberValue(choose(["TEMPERATURE", "temperature"], 0.7), "TEMPERATURE");
  let maxTokens = numberValue(choose(["MAX_TOKENS", "maxTokens"], 2048), "MAX_TOKENS");
  // Task values are untrusted. Only sampling controls may override resolved config.
  for (const options of taskOverrides) {
    temperature = numberValue(selected([record(options)], ["TEMPERATURE", "temperature"], temperature), "TEMPERATURE");
    maxTokens = numberValue(selected([record(options)], ["MAX_TOKENS", "maxTokens"], maxTokens), "MAX_TOKENS");
  }
  const rawApiKey = choose(["API_KEY", "apiKey"], "ollama");
  const apiKey = validateBearerCredential(rawApiKey, "API_KEY") ?? "";
  return {
    baseUrl: validateEndpoint(choose(["BASE_URL", "baseUrl"], "http://localhost:11434/v1"), "BASE_URL"),
    apiKey,
    model: stringValue(choose(["MODEL", "model"], "qwen2.5-coder:1.5b"), "MODEL"),
    temperature,
    maxTokens,
    systemPrompt: stringValue(choose(["SYSTEM_PROMPT", "systemPrompt"], defaultSystemPrompt), "SYSTEM_PROMPT", true),
    // Adapter-specific BASE_URL aliases remain supported at every config level.
    // Reserved env.PAPERCLIP_API_URL/API_KEY cannot replace host URL/run identity.
    paperclipBaseUrl: validateEndpoint(choose(["PAPERCLIP_BASE_URL", "paperclipBaseUrl"], runtimeApiUrl()), "PAPERCLIP_BASE_URL"),
    autoMarkDone: booleanValue(choose(["AUTO_MARK_DONE", "autoMarkDone"], false), "AUTO_MARK_DONE"),
    enablePaperclipActions: booleanValue(choose(["ENABLE_PAPERCLIP_ACTIONS", "enablePaperclipActions"], true), "ENABLE_PAPERCLIP_ACTIONS"),
    runtimeSkills: readRuntimeSkills(config),
  };
}
