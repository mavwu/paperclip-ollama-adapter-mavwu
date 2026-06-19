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
MODEL=nemotron-3-super:cloud
TEMPERATURE=0.7
MAX_TOKENS=2048
SYSTEM_PROMPT=You are a model being used through a Paperclip adapter. Respond only with the final useful answer. Do not mention Paperclip, Ollama, NVIDIA, adapters, identity, reasoning, or internal system details unless the user specifically asks.
```

Paperclip config can use either uppercase keys or camelCase keys, for example `BASE_URL` or `baseUrl`, `MAX_TOKENS` or `maxTokens`.

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
