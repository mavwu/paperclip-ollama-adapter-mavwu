# Paperclip Ollama Adapter

Paperclip external adapter package for running Paperclip agents through Ollama's OpenAI-compatible API.

Package name:

```bash
paperclip-ollama-adapter-mavwu
```

## Architecture

```text
Paperclip agent/task
-> Paperclip external adapter
-> Ollama OpenAI-compatible endpoint
-> Ollama model
-> response returned to Paperclip
```

The adapter posts chat completions to:

```text
http://localhost:11434/v1/chat/completions
```

## Paperclip Contract

The package root exports the metadata and server factory Paperclip expects:

- `type`
- `label`
- `models`
- `agentConfigurationDoc`
- `createServerAdapter`

`createServerAdapter()` returns:

- `type`
- `execute`
- `testEnvironment`
- `models`
- `agentConfigurationDoc`

For Paperclip's npm/upload install path, the package also declares:

```json
{
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js"
  }
}
```

The manifest module ships in the published tarball and points Paperclip at the adapter's `createServerAdapter` export.

Adapter type: `ollama_local`

Adapter label: `Ollama Local`

## Models

Built-in model choices:

- `qwen2.5-coder:1.5b`
- `nemotron-3-super:cloud`
- `qwen2.5-coder:7b`
- `llama3.1:8b`
- `codellama:7b`
- `mistral:7b`

You can still use any Ollama model by setting `MODEL`.

## Configuration

Create a `.env` file or provide values through Paperclip adapter config:

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

Paperclip config can use either uppercase keys or camelCase keys, for example `BASE_URL` or `baseUrl`, `MAX_TOKENS` or `maxTokens`.

Successful adapter runs mark the touched Paperclip issue `done` by default. Set `AUTO_MARK_DONE=false` for multi-step work where the issue should remain open, blocked, in review, or continue through another run.

When `ENABLE_PAPERCLIP_ACTIONS=true`, the adapter can use Paperclip's local API to inspect visible company agents and create assigned follow-up tasks for explicit delegation requests, as well as create new agents for hiring requests (e.g., 'hire a CTO'). This lets prompts like 'tell CTO to review this' become an actual Paperclip task, and prompts like 'hire a CTO' create a new agent in your company.

## Local Development

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run the local Ollama integration test:

```bash
npm test
```

The test sends a prompt through `execute()` and expects Ollama to be running with the configured model available.

Verify package exports:

```bash
node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"
```

Expected keys include:

```text
type
label
models
agentConfigurationDoc
createServerAdapter
```

Verify the server adapter object:

```bash
node -e "import('./dist/index.js').then(m => console.log(m.createServerAdapter()))"
```

Expected object includes:

```text
type
execute
testEnvironment
models
agentConfigurationDoc
```

Verify the plugin manifest export:

```bash
node -e "import('./dist/manifest.js').then(m => console.log(m.default ?? m.manifest))"
```

## Publish

After validating locally:

```bash
npm version patch
npm publish
```

Install this adapter in Paperclip using:

```text
paperclip-ollama-adapter-mavwu
```

On Windows, if local-path installation fails with `Received protocol 'c:'`, use the npm package route or upgrade Paperclip to a build that converts Windows paths with `pathToFileURL()` before ESM import.

## Troubleshooting

- Start Ollama with `ollama serve`.
- Confirm `BASE_URL` points to the OpenAI-compatible `/v1` endpoint.
- Confirm the configured model is available with `ollama list`.
- Pull a missing model with `ollama pull <model-name>`.

## License

MIT
