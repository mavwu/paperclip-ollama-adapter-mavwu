import axios from "axios";
import "dotenv/config";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { type } from "../metadata.js";
import { readResponseText } from "./response.js";
import { readOllamaConfig } from "./config.js";
import { collectDiagnosticSecrets, describeError, sanitizeDiagnosticText } from "./diagnostics.js";

export async function testEnvironment(
  context: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = readOllamaConfig(context.config);
  const secrets = collectDiagnosticSecrets(process.env, context.config, { apiKey: config.apiKey });
  const checks: AdapterEnvironmentCheck[] = [
    {
      code: "ollama_config",
      level: "info",
      message: `Using ${config.model} at ${sanitizeDiagnosticText(config.baseUrl, secrets)}`,
    },
  ];

  try {
    const response = await axios.post(
      `${config.baseUrl}/chat/completions`,
      {
        model: config.model,
        messages: [{ role: "user", content: "Reply with exactly ok." }],
        temperature: 0,
        max_tokens: 8,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
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
  }
}
