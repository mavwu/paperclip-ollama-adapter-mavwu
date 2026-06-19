import axios from "axios";
import "dotenv/config";
import { fileURLToPath } from "node:url";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";
import { type } from "../metadata.js";
import { execute } from "./execute.js";
import { readOllamaConfig } from "./config.js";

export async function testEnvironment(
  context: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = readOllamaConfig(context.config);
  const checks: AdapterEnvironmentCheck[] = [
    {
      code: "ollama_config",
      level: "info",
      message: `Using ${config.model} at ${config.baseUrl}`,
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
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      code: "ollama_probe_failed",
      level: "error",
      message: "Ollama chat completions probe failed.",
      detail: message,
      hint: "Start Ollama, verify BASE_URL, and make sure the configured MODEL is available.",
    });

    return {
      adapterType: type,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }
}

async function runLocalTest(): Promise<void> {
  const result = await execute({
    runId: "local-test",
    agent: {
      id: "local-agent",
      companyId: "local-company",
      name: "Local Test Agent",
      adapterType: type,
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "local-test",
    },
    config: {},
    context: {
      prompt:
        "Create a simple JavaScript function called addNumbers that takes two numbers and returns their sum. Return only the code.",
    },
    onLog: async (stream, chunk) => {
      const writer = stream === "stderr" ? console.error : console.log;
      writer(chunk);
    },
  } satisfies AdapterExecutionContext);

  console.log(JSON.stringify(result, null, 2));

  if (result.exitCode !== 0) {
    throw new Error(result.errorMessage ?? "Local Ollama adapter test failed.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLocalTest().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
