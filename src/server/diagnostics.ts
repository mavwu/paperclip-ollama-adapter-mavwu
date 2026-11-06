// Diagnostics are an untrusted text boundary: never serialize response/config,
// request headers, error causes, or stacks into a result or log.
const MAX_DETAIL_LENGTH = 16_384;
const MAX_ERROR_LENGTH = 512;
const SENSITIVE_KEY = /api[_-]?key|token|secret|password|credential|authorization|cookie/i;

function own(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== "object") return undefined;
    // Do not invoke provider-defined getters or toString/toJSON methods.
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

export function collectDiagnosticSecrets(...sources: unknown[]): string[] {
  const secrets = new Set<string>();
  const seen = new Set<object>();
  function visit(source: unknown, depth: number) {
    if (!source || typeof source !== "object" || depth > 4 || seen.has(source)) return;
    seen.add(source);
    try {
      for (const key of Object.keys(source)) {
        const value = own(source, key);
        if (SENSITIVE_KEY.test(key) && typeof value === "string" && value) secrets.add(value);
        else if (value && typeof value === "object") visit(value, depth + 1);
      }
    } catch { /* Proxy traps and malformed config are not diagnostic authority. */ }
  }
  for (const source of sources) visit(source, 0);
  return [...secrets];
}

export function sanitizeDiagnosticText(value: unknown, secrets: readonly string[]): string {
  if (typeof value !== "string" || !value.trim()) return "Diagnostic detail unavailable.";
  if (value.length > MAX_DETAIL_LENGTH) return "Diagnostic detail omitted (oversized).";
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) ||
      /(?:javascript|vbscript|data):|&(?:lt|gt);|\n\s*at\s/i.test(value)) {
    return "Diagnostic detail omitted (unsafe content).";
  }
  let text = value;
  // Match whole known values, including common encodings, before truncating.
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    try { variants.add(encodeURIComponent(secret)); } catch { /* malformed Unicode */ }
  }
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
  text = text
    .replace(/\b(?:https?|file):\/\/[^\s<>"')]+/gi, "[REDACTED URL]")
    .replace(/\b[\w-]*(?:authorization|cookie|api[_-]?key|token|secret|password|credential)[\w-]*\s*:\s*[^\r\n]+/gi, "[REDACTED HEADER]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, "[REDACTED]")
    .replace(/(["']?[\w-]*(?:api[_-]?key|token|secret|password|credentials?|authorization|cookie)[\w-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]")
    .replace(/\b(?:sk-|ghp_|github_pat_|npm_)[\w-]{8,}/g, "[REDACTED]")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:home|Users|etc|var|tmp|run|private)\/)[^\s"'<>]+/g, "[REDACTED PATH]")
    .replace(/\s+/g, " ").trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 3)}...` : text;
}

export function errorHttpStatus(error: unknown): number | undefined {
  const status = own(own(error, "response"), "status");
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function providerMessage(data: unknown): unknown {
  if (typeof data === "string") {
    if (data.length > MAX_DETAIL_LENGTH) return data;
    const text = data.trim();
    if (/^[\[{]/.test(text)) {
      try { return providerMessage(JSON.parse(text)); } catch { return undefined; }
    }
    return text;
  }
  if (Array.isArray(data)) return undefined;
  const error = own(data, "error");
  for (const value of [own(error, "message"), error, own(data, "message"), own(data, "detail")]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function describeError(error: unknown, secrets: readonly string[]): string {
  try {
    const status = errorHttpStatus(error);
    const message = providerMessage(own(own(error, "response"), "data")) ??
      own(error, "message") ?? (typeof error === "string" ? error : undefined);
    const detail = sanitizeDiagnosticText(message, secrets);
    const prefix = status === undefined ? "" : `HTTP ${status}: `;
    return `${prefix}${detail}`.slice(0, MAX_ERROR_LENGTH);
  } catch {
    return "Diagnostic detail unavailable.";
  }
}
