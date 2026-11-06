// Explicitly opt-in inference smoke test. Never supplies a Paperclip token or issue.
import { execute } from "../dist/server/execute.js";

const result = await execute({
  runId: "local-smoke",
  agent: { id: "local-agent", companyId: "local-company", name: "Local Test Agent", adapterType: "ollama_local", adapterConfig: {} },
  runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
  config: { ENABLE_PAPERCLIP_ACTIONS: false, AUTO_MARK_DONE: false },
  context: { prompt: "Create a simple JavaScript function called addNumbers that takes two numbers and returns their sum. Return only the code." },
  onLog: async (stream, chunk) => (stream === "stderr" ? console.error : console.log)(chunk),
});
console.log(JSON.stringify(result, null, 2));
if (result.exitCode !== 0) process.exitCode = 1;
