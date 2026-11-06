import "dotenv/config";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { type } from "../metadata.js";
import { readResponseText } from "./response.js";
import { readOllamaConfig } from "./config.js";
import { collectDiagnosticSecrets, describeError, redactKnownSecrets, sanitizeDiagnosticText } from "./diagnostics.js";
import { createServiceClients } from "./http.js";
import { ExecutionControl } from "./lifecycle.js";

export async function testEnvironment(
  context: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const secrets = collectDiagnosticSecrets(process.env, context.config);
  const checks: AdapterEnvironmentCheck[] = [];
  let control: ExecutionControl | undefined;

  try {
    const config = readOllamaConfig(context.config);
    // Only supplied credentials are secrets; the implicit "ollama" default is public.
    control = new ExecutionControl({}, Math.min(config.executionTimeoutMs, 30_000));
    const clients = createServiceClients(config, undefined, 30_000, control);
    checks.push({
      code: "ollama_config",
      level: "info",
      message: `Using ${redactKnownSecrets(config.model, secrets)} at ${sanitizeDiagnosticText(config.baseUrl, secrets)}`,
    });
    const response = await clients.complete(
      {
        model: config.model,
        messages: [{ role: "user", content: "Reply with exactly ok." }],
        temperature: 0,
        max_tokens: 8,
        stream: false,
      },
    );

    readResponseText(response.data);

    checks.push({
      code: "ollama_probe",
      level: "info",
      message: "Ollama chat completions probe succeeded.",
      detail: `HTTP ${response.status}`,
    });

    return {
      adapterType: type,
      status: "pass",
      checks,
      testedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = describeError(error, secrets);
    checks.push({
      code: "ollama_probe_failed",
      level: "error",
      message: "Ollama chat completions probe failed.",
      detail: message,
      hint: "Verify BASE_URL and MODEL, and check the error detail for empty, truncated, refused, or unsupported tool output.",
    });

    return {
      adapterType: type,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  } finally {
    control?.dispose();
  }
}
