type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export class ModelResponseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ModelResponseError";
  }

  static codeOf(error: unknown): string | undefined {
    try {
      if (!(error instanceof ModelResponseError)) return undefined;
      const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
      return typeof code === "string" && /^OLLAMA_(?:UNSUPPORTED_TOOL_CALL|REFUSAL|TRUNCATED_RESPONSE|INCOMPLETE_RESPONSE|EMPTY_RESPONSE)$/.test(code)
        ? code : undefined;
    } catch {
      // Error-like objects can have hostile prototype traps or accessors.
      return undefined;
    }
  }
}

// A transport-level success does not prove that a usable final answer was returned.
// Reasoning is deliberately not a fallback for missing user-visible content.
export function readResponseText(data: unknown): string {
  const root = record(data);
  const choice = record(Array.isArray(root.choices) ? root.choices[0] : undefined);
  const message = record(choice.message ?? root.message);
  if ((Array.isArray(message.tool_calls) && message.tool_calls.length > 0) || message.function_call ||
      choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") {
    throw new ModelResponseError("OLLAMA_UNSUPPORTED_TOOL_CALL", "The model requested tools, but this adapter cannot execute tool calls.");
  }
  if (message.refusal) {
    throw new ModelResponseError("OLLAMA_REFUSAL", "The model refused the request.");
  }
  const finishReason = choice.finish_reason !== undefined ? choice.finish_reason : root.done_reason;
  if (finishReason === "length") {
    throw new ModelResponseError("OLLAMA_TRUNCATED_RESPONSE", "The model response was truncated by its output limit.");
  }
  if (root.done === false || (finishReason !== undefined && finishReason !== "stop")) {
    throw new ModelResponseError("OLLAMA_INCOMPLETE_RESPONSE", "The model did not return a complete final response.");
  }
  for (const value of [message.content, choice.text, root.response]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new ModelResponseError("OLLAMA_EMPTY_RESPONSE", "The model returned no usable response text.");
}
