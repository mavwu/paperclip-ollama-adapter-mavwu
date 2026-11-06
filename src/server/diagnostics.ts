// Diagnostics are an untrusted text boundary: never serialize response/config,
// request headers, error causes, or stacks into a result or log.
const MAX_DETAIL_LENGTH = 16_384;
const MAX_ERROR_LENGTH = 512;
// Only named credential classes (optionally prefixed by a vendor/scope) are
// secrets. A substring such as "token" in maxTokens is not credential evidence.
const CREDENTIAL_CLASSES = [
  "api_key", "api_token", "auth_token", "access_token", "refresh_token", "id_token",
  "bearer_token", "session_token", "client_secret", "secret_key", "private_key",
  "signing_key", "encryption_key", "secret_access_key", "secret_header",
  "token", "secret", "password", "passwd", "credential", "credentials",
  "authorization", "cookie", "set_cookie",
];
const CREDENTIAL_NAMES = new Set(CREDENTIAL_CLASSES.flatMap(name => [name, name.replaceAll("_", "")]));
const PUBLIC_SETTINGS = new Set([
  "maxtokens", "mintokens", "maxtoken", "maxoutputtokens", "maxinputtokens", "maxcompletiontokens", "maxnewtokens",
  "tokencount", "tokenlimit", "tokenbudget", "prompttokens", "completiontokens", "inputtokens", "outputtokens",
  "temperature", "topp", "topk", "minp", "seed", "repeatpenalty", "frequencypenalty", "presencepenalty",
]);

function credentialField(key: string): boolean {
  const name = key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (PUBLIC_SETTINGS.has(name.replaceAll("_", ""))) return false;
  return CREDENTIAL_NAMES.has(name) || CREDENTIAL_CLASSES.some(suffix => name.endsWith(`_${suffix}`));
}

function redactCredentialHeaders(text: string): string {
  return text.split(/\r?\n/).map(line => {
    for (const match of line.matchAll(/\b([\w-]+)\s*:/g)) {
      if (credentialField(match[1])) return `${line.slice(0, match.index)}[REDACTED HEADER]`;
    }
    return line;
  }).join("\n");
}

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
        if (credentialField(key) && typeof value === "string" && value) secrets.add(value);
        else if (value && typeof value === "object") visit(value, depth + 1);
      }
    } catch { /* Proxy traps and malformed config are not diagnostic authority. */ }
  }
  for (const source of sources) visit(source, 0);
  return [...secrets];
}

export function redactKnownSecrets(value: string, secrets: readonly string[]): string {
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
  return text;
}

// Invocation metadata is adapter-owned plain data. Redact keys and values without
// truncating legitimate prompts or applying the stricter error-body filter.
export function redactInvocation<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redactKnownSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map(entry => redactInvocation(entry, secrets)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).map(key => [redactKnownSecrets(key, secrets), redactInvocation(own(value, key), secrets)])) as T;
  return value;
}

export function sanitizeDiagnosticText(value: unknown, secrets: readonly string[]): string {
  if (typeof value !== "string" || !value.trim()) return "Diagnostic detail unavailable.";
  if (value.length > MAX_DETAIL_LENGTH) return "Diagnostic detail omitted (oversized).";
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) ||
      /(?:javascript|vbscript|data):|&(?:lt|gt);|\n\s*at\s/i.test(value)) {
    return "Diagnostic detail omitted (unsafe content).";
  }
  const text = redactCredentialHeaders(redactKnownSecrets(value, secrets)
    .replace(/\b(?:https?|file):\/\/[^\s<>"')]+/gi, "[REDACTED URL]"))
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, "[REDACTED]")
    .replace(/(["']?([\w-]+)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/g, (match, prefix: string, key: string) => credentialField(key) ? `${prefix}[REDACTED]` : match)
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
