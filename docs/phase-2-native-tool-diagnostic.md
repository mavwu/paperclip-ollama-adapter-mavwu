# Phase 2 native tool diagnostic — 2026-11-06

This supplements the earlier prototype report. Original documentation, provider config, traces and runtime logs were preserved. No adapter application code changed.

## Native protocol evidence

Runtime: Ollama 0.32.5, Node 24.11.1, Windows CPU inference. A separate server bound to loopback used the existing local model store with cloud disabled, one parallel request and one loaded model. HTTP readiness was established by a successful `/api/version` response, independently of model readiness.

Each native `/api/chat` request used `stream:false`, `think:false`, temperature 0, seed 42, `num_ctx:2048`, `num_predict:128`, and `keep_alive:0`, with a 45-second client deadline. The harmless function schema was:

```json
{
  "type": "function",
  "function": {
    "name": "add_integers",
    "description": "Add two integers. Call this tool to calculate the requested result.",
    "parameters": {
      "type": "object",
      "properties": {"a":{"type":"integer"},"b":{"type":"integer"}},
      "required": ["a","b"],
      "additionalProperties": false
    }
  }
}
```

The user message requested a tool call to calculate 17 plus 25. No tool had filesystem, command or network capabilities. The probe would dispatch only a validated `add_integers` call with integer arguments; none was received, so no function was executed.

| Model | HTTP/latency | Observed result |
|---|---|---|
| `qwen2.5-coder:1.5b` | 200 / 18.187 seconds | Fenced JSON in `message.content`; no `message.tool_calls`. Load 14.226 s, prompt evaluation 2.164 s, generation 1.778 s. 196 prompt tokens, 39 generated tokens, normal stop. |
| `qwen2:1.5b` | 400 / 0.310 seconds | Ollama explicitly rejected the model as not supporting tools. |
| `qwen3:4b-instruct` | Client timeout / 45.002 seconds | Runtime log ends during model tensor loading; no structured model response. |

The coder response was ordinary text containing `name: add_integers` and arguments 17 and 25. It is not a tool invocation. This reproduces the earlier OpenCode symptom directly through the native API with a tiny prompt, before the OpenAI-compatible provider or OpenCode is involved. It does not identify whether model behavior, its installed chat template, or Ollama's extraction contributes to the failure; those inner boundaries remain unresolved. A 196-token native prompt does not support attributing this reproduction to OpenCode's large prompt or context truncation.

No model passed the native prerequisite. OpenAI-compatible tool-choice/argument translation and streamed deltas were therefore not exercised, and the fixture was not retried. There is no evidence that OpenCode lost a valid structured call.

## Earlier Qwen 3 attempt: preserved log findings

The preserved OpenCode log provides more precise evidence than the earlier stdout capture:

- Initial title and build requests received model-not-found errors. The initial isolated server used the wrong model store; later requests used the correct model identifier.
- The later 32K-context attempt reached the provider. Ollama reported an out-of-memory startup failure allocating a 4,831,838,208-byte CPU buffer for the KV cache. OpenCode subsequently began another stream attempt. The blank JSONL capture was not evidence that no provider request occurred.
- Both title and build agents used the same local model, producing additional requests. The provider configuration's model map key was correct; its stale human-readable model label was misleading but not the requested model ID.
- OpenCode also logged failed background `models.dev` fetches. Denying model web tools and disabling updates/plugins did not prevent this runtime network attempt. Future fixture execution needs a process-level egress boundary that permits only the local model endpoint.

The new small-context native attempt is distinct: the server logged about 6.7 GiB free system RAM and a projected Qwen 3 host/context allocation of about 1,062 MiB plus 1,683 MiB repacked weights. Its captured log stopped at tensor loading. No new out-of-memory error or completed inference was observed within the deadline. Do not conflate the prior confirmed KV-cache allocation failure with the new loading timeout or infer a universal model capability failure.

## Result and next action

No genuine OpenCode tool event, fixture modification or agent-run test has been demonstrated. The prior fixture remains unchanged. The original Ollama startup logs had already been sanitized in the preceding investigation; the preserved OpenCode runtime log supplied the allocation failure above. New raw response evidence and filtered runtime logs are retained separately in the ignored diagnostic cache. No original evidence was overwritten.

Recommend C: retain Mavwu's inference-only behavior. The smallest next step is to make one installed model produce a valid native tool call under a context/memory configuration this machine can load, investigating the installed coder template/parser or a separately bounded warm-load experiment for Qwen 3. Only after that succeeds should the OpenAI-compatible streaming boundary and restricted OpenCode fixture be tested. Existing harnesses remain candidates; a custom loop would not repair the demonstrated native failure. Cloud models remain a future option requiring explicit authorization.

The full Paperclip host was not launched. Delegation storage remains disabled. No models or dependencies were downloaded, and no cloud inference was used. The diagnostic server and its runner were stopped; no test listener remained. Application code was unchanged, so the existing 482-test adapter suite was not rerun. Whitespace verification was performed on the documentation changes.
