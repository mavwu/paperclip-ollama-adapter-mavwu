# Adapter Configuration Reference

Configuration can come from environment variables, a `.env` file, or Paperclip adapter config. Paperclip config supports both uppercase and camelCase keys.

## Defaults

| Variable | camelCase | Default |
| --- | --- | --- |
| `BASE_URL` | `baseUrl` | `http://localhost:11434/v1` |
| `API_KEY` | `apiKey` | `ollama` |
| `MODEL` | `model` | `nemotron-3-super:cloud` |
| `TEMPERATURE` | `temperature` | `0.7` |
| `MAX_TOKENS` | `maxTokens` | `2048` |
| `SYSTEM_PROMPT` | `systemPrompt` | See below |

Default system prompt:

```text
You are a model being used through a Paperclip adapter. Respond only with the final useful answer. Do not mention Paperclip, Ollama, NVIDIA, adapters, identity, reasoning, or internal system details unless the user specifically asks.
```

## Example `.env`

```env
BASE_URL=http://localhost:11434/v1
API_KEY=ollama
MODEL=nemotron-3-super:cloud
TEMPERATURE=0.7
MAX_TOKENS=2048
SYSTEM_PROMPT=You are a model being used through a Paperclip adapter. Respond only with the final useful answer. Do not mention Paperclip, Ollama, NVIDIA, adapters, identity, reasoning, or internal system details unless the user specifically asks.
```

## Request Behavior

The adapter sends:

```json
{
  "model": "nemotron-3-super:cloud",
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
