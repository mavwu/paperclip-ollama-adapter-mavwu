# Adapter Configuration Reference

Configuration can come from environment variables, a `.env` file, or Paperclip adapter config. Paperclip config supports both uppercase and camelCase keys.

## Defaults

| Variable | camelCase | Default |
| --- | --- | --- |
| `BASE_URL` | `baseUrl` | `http://localhost:11434/v1` |
| `API_KEY` | `apiKey` | `ollama` |
| `MODEL` | `model` | `qwen2.5-coder:1.5b` |
| `TEMPERATURE` | `temperature` | `0.7` |
| `MAX_TOKENS` | `maxTokens` | `2048` |
| `SYSTEM_PROMPT` | `systemPrompt` | See below |
| `AUTO_MARK_DONE` | `autoMarkDone` | `true` |
| `PAPERCLIP_BASE_URL` | `paperclipBaseUrl` | `http://127.0.0.1:3100` |
| `ENABLE_PAPERCLIP_ACTIONS` | `enablePaperclipActions` | `true` |

Default system prompt:

```text
You are operating as the Paperclip agent named in the run context. Stay in that agent role for company, task, and chat interactions, including when the user asks about your role. Treat the latest user request or wake comment as the current instruction. Use older task, issue, and conversation context only as background unless the latest request explicitly asks you to revisit it. Be direct, practical, and truthful. Do not claim that you used tools, edited files, ran commands, contacted services, or changed Paperclip state unless the run context or adapter result actually did that. If the task is simple and complete, give the final answer clearly. If the task cannot be completed from the available context, say what is missing or what is blocked instead of inventing results. Do not claim to be the underlying model, runtime, adapter, Ollama, or Paperclip internals unless the user specifically asks about implementation details. Respond with the final useful answer only.
```

## Example `.env`

```env
BASE_URL=http://localhost:11434/v1
API_KEY=ollama
MODEL=qwen2.5-coder:1.5b
TEMPERATURE=0.7
MAX_TOKENS=2048
SYSTEM_PROMPT=You are operating as the Paperclip agent named in the run context. Stay in that agent role for company, task, and chat interactions, including when the user asks about your role. Treat the latest user request or wake comment as the current instruction. Use older task, issue, and conversation context only as background unless the latest request explicitly asks you to revisit it. Be direct, practical, and truthful. Do not claim that you used tools, edited files, ran commands, contacted services, or changed Paperclip state unless the run context or adapter result actually did that. If the task is simple and complete, give the final answer clearly. If the task cannot be completed from the available context, say what is missing or what is blocked instead of inventing results. Do not claim to be the underlying model, runtime, adapter, Ollama, or Paperclip internals unless the user specifically asks about implementation details. Respond with the final useful answer only.
AUTO_MARK_DONE=true
PAPERCLIP_BASE_URL=http://127.0.0.1:3100
ENABLE_PAPERCLIP_ACTIONS=true
```

## Paperclip Issue Disposition

Paperclip expects successful issue runs to choose a durable final disposition such as `done`, `blocked`, `in_review`, or a continuation path. This adapter is a direct Ollama chat-completion adapter, so it cannot perform a full tool-using workflow by itself.

By default, successful responses automatically mark the touched Paperclip issue `done` through the local Paperclip API. This is useful for simple one-shot tasks and prevents Paperclip from queuing missing-disposition recovery runs.

Leave `AUTO_MARK_DONE=false` for exploratory, review, blocked, or multi-step work where a human or a richer agent workflow should decide the issue status.

## Paperclip Company Actions

When `ENABLE_PAPERCLIP_ACTIONS=true`, the adapter uses the local Paperclip API and the run's local agent JWT to inspect visible company agents when a prompt asks about agents, the org chart, assignments, delegation, or handoffs.

For explicit delegation requests such as "tell CTO to review this" or "assign this to the Mathematician", the adapter asks the configured Ollama model for a compact delegation plan, matches the assignee against visible Paperclip agents, and creates a `todo` follow-up issue assigned to that agent. The current issue can then be marked `done` by `AUTO_MARK_DONE`.

Set `ENABLE_PAPERCLIP_ACTIONS=false` if you only want chat-completion responses and do not want the adapter to create Paperclip tasks.

## Request Behavior

The adapter sends:

```json
{
  "model": "qwen2.5-coder:1.5b",
  "messages": [
    { "role": "system", "content": "configured system prompt" },
    { "role": "user", "content": "prompt extracted from Paperclip context" }
  ],
  "temperature": 0.7,
  "max_tokens": 2048,
  "stream": false
}
```

to:

```text
${BASE_URL}/chat/completions
```

## Prompt Extraction

The official `AdapterExecutionContext` includes `context`, `config`, `agent`, and `runtime`. The adapter prefers likely prompt fields inside that structure and also supports prototype-style fields defensively:

- `context.prompt`
- `context.input`
- `context.message`
- `context.task.prompt`
- `context.task.input`
- `prompt`
- `input`
- `message`
- `task.prompt`
- `task.input`
- `runtime.prompt`
- `runtime.input`
- `agent.prompt`

## Response Extraction

The adapter accepts common OpenAI-compatible and reasoning-model response fields:

- `choices[0].message.content`
- `choices[0].message.reasoning`
- `choices[0].message.reasoning_content`
- `choices[0].text`
- `message.content`
- `response`

## Testing

```bash
npm install
npm run build
npm test
```

`npm test` uses the compiled Paperclip `execute()` function and performs a real Ollama request.

## Installation Modes

Paperclip's npm/upload installation flow expects a plugin package, so this package declares `paperclipPlugin.manifest` in `package.json` and ships `dist/manifest.js`.

Paperclip's local path route can load a bare adapter package, but some Windows builds fail when they pass `C:\...` directly to Node's ESM loader. If local path installation fails with `Received protocol 'c:'` or `ERR_UNSUPPORTED_ESM_URL_SCHEME`, use the npm package install route or upgrade Paperclip to a build with the Windows file URL import fix.
