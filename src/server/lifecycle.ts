import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { performance } from "node:perf_hooks";

// These optional fields are verified against current official Paperclip source.
// adapter-utils 2026.609.0 does not declare them; older hosts may omit them.
export type LifecycleContext = AdapterExecutionContext & {
  signal?: AbortSignal;
  onCancellationReady?: () => Promise<void>;
  onDispatch?: () => void;
};

const MESSAGES = {
  cancelled: "Execution was cancelled. No additional work will be started.",
  EXECUTION_DEADLINE_EXCEEDED: "The overall execution deadline was exceeded.",
  MODEL_REQUEST_TIMEOUT: "The model request exceeded its deadline.",
  PAPERCLIP_REQUEST_TIMEOUT: "The Paperclip request exceeded its deadline.",
  ADAPTER_LIFECYCLE_FAILED: "The host lifecycle callback failed or supplied an unsupported lifecycle contract. No further request was started.",
} as const;
export type ExecutionErrorCode = keyof typeof MESSAGES;

export class ExecutionError extends Error {
  readonly timedOut: boolean;
  constructor(readonly code: ExecutionErrorCode) {
    super(MESSAGES[code]);
    this.name = "ExecutionError";
    this.timedOut = code === "EXECUTION_DEADLINE_EXCEEDED" || code.endsWith("_TIMEOUT");
  }
}
export function executionError(error: unknown): ExecutionError | undefined {
  try { return error instanceof ExecutionError ? error : undefined; } catch { return undefined; }
}
export function executionErrorCode(value: unknown): ExecutionErrorCode | undefined {
  return typeof value === "string" && Object.hasOwn(MESSAGES, value) ? value as ExecutionErrorCode : undefined;
}

export class ExecutionControl {
  readonly controller = new AbortController();
  private reason?: ExecutionError;
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cancel = () => this.stop("cancelled");
  private dispatched = false;

  constructor(private readonly context: Partial<LifecycleContext>, timeoutMs: number, startedAt = performance.now()) {
    const signal = context.signal;
    if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) throw new ExecutionError("ADAPTER_LIFECYCLE_FAILED");
    this.expiresAt = startedAt + timeoutMs;
    try { signal?.addEventListener("abort", this.cancel, { once: true }); }
    catch { throw new ExecutionError("ADAPTER_LIFECYCLE_FAILED"); }
    this.timer = setTimeout(() => this.stop("EXECUTION_DEADLINE_EXCEEDED"), Math.max(1, Math.ceil(this.expiresAt - performance.now())));
    if (signal?.aborted) this.cancel();
  }
  private stop(code: ExecutionErrorCode) {
    if (this.reason) return;
    this.reason = new ExecutionError(code);
    // Never forward or log a host abort reason: it can contain internal secrets.
    this.controller.abort(this.reason);
  }
  check() {
    if (!this.reason && performance.now() >= this.expiresAt) this.stop("EXECUTION_DEADLINE_EXCEEDED");
    if (this.reason) throw this.reason;
  }
  get error() { return this.reason; }
  remaining() { this.check(); return Math.max(1, Math.ceil(this.expiresAt - performance.now())); }
  async ready() {
    if (this.context.onCancellationReady !== undefined) {
      if (!this.context.signal || typeof this.context.onCancellationReady !== "function") throw new ExecutionError("ADAPTER_LIFECYCLE_FAILED");
      try { await this.context.onCancellationReady(); } catch { throw this.reason ?? new ExecutionError("ADAPTER_LIFECYCLE_FAILED"); }
    }
    this.check();
  }
  dispatch() {
    this.check();
    if (!this.dispatched) {
      if (this.context.onDispatch !== undefined) {
        if (typeof this.context.onDispatch !== "function") throw new ExecutionError("ADAPTER_LIFECYCLE_FAILED");
        try {
          const result: unknown = this.context.onDispatch();
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            void Promise.resolve(result).catch(() => {});
            throw new ExecutionError("ADAPTER_LIFECYCLE_FAILED");
          }
        } catch { throw this.reason ?? new ExecutionError("ADAPTER_LIFECYCLE_FAILED"); }
      }
      this.dispatched = true;
    }
    this.check();
  }
  dispose() { clearTimeout(this.timer); this.context.signal?.removeEventListener("abort", this.cancel); }
}

// One child signal per request: an optional enrichment timeout must not cancel
// subsequent inference, whereas a host stop/overall deadline cancels every child.
export function requestControl(timeoutMs: number, code: "MODEL_REQUEST_TIMEOUT" | "PAPERCLIP_REQUEST_TIMEOUT", parent?: ExecutionControl) {
  const effectiveTimeout = Math.min(timeoutMs, parent?.remaining() ?? timeoutMs);
  const expiresAt = performance.now() + timeoutMs;
  const controller = new AbortController();
  let reason: ExecutionError | undefined;
  const stop = (error: ExecutionError) => { if (!reason) { reason = error; controller.abort(error); } };
  const cancel = () => stop(parent?.error ?? new ExecutionError("cancelled"));
  // Promise continuations can run before overdue timer callbacks. Enforce the
  // same monotonic budget at checkpoints instead of accepting a late response.
  const checkDeadline = () => { if (!reason && performance.now() >= expiresAt) stop(new ExecutionError(code)); };
  parent?.controller.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stop(new ExecutionError(code)), timeoutMs);
  return {
    signal: controller.signal,
    timeoutMs: effectiveTimeout,
    failure(error: unknown): unknown {
      try { parent?.check(); } catch (stop) { return stop; }
      checkDeadline();
      if (parent?.error) return parent.error;
      if (reason) return reason;
      let nativeCode: unknown;
      try { nativeCode = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined; } catch { /* hostile error */ }
      return nativeCode === "ECONNABORTED" || nativeCode === "ETIMEDOUT" ? new ExecutionError(code) : error;
    },
    check() { parent?.check(); checkDeadline(); if (reason) throw reason; },
    dispose() { clearTimeout(timer); parent?.controller.signal.removeEventListener("abort", cancel); },
  };
}
