# Paperclip Ollama Adapter

External Paperclip adapter for text inference through Ollama's OpenAI-compatible API, with limited follow-up task creation.

Package: `paperclip-ollama-adapter-mavwu` · Adapter type: `ollama_local`

## Supported behavior

- Sends a non-streaming request to `${BASE_URL}/chat/completions`.
- Returns usable final text and basic token usage to Paperclip.
- Can inspect visible company agents and create one assigned `todo` follow-up for an explicit delegation request, using the run's Paperclip identity.
- Rejects ambiguous or ineligible assignees and records failed actions as failed execution results.

This is a one-shot adapter. It does not execute model tools, edit files, run commands, hire agents, load runtime skills, or maintain conversation history. The skill files in `Paperclip-skills/` are reference material; they are not delivered at runtime. A generated answer or created follow-up does not prove that the source task was completed.

## Completion and action outcomes

The adapter never automatically marks an issue `done`. `AUTO_MARK_DONE` now defaults to `false` and remains accepted as a deprecated compatibility setting. Even an existing `true` value cannot close an issue: the adapter has no verified-completion mechanism.

Results distinguish:

| `resultJson.stopReason` | Meaning |
| --- | --- |
| `response_received` | Usable model text was returned; no task-completion claim. |
| `delegated` | Paperclip returned an issue ID for the follow-up; its execution is separate. |
| `failed` | Inference or a required organizational operation could not be confirmed. |

`resultJson.success` and `exitCode` describe adapter execution. `workflowCompleted` remains `false`. Failed required actions return `success: false`, a nonzero exit code, an error code and action details. Optional enrichment can fail while valid inference succeeds; that lookup is still recorded with `success: false` and `required: false`. Empty, truncated, refused, reasoning-only and unsupported tool-call responses fail instead of being treated as finished work.

Paperclip or a capable agent workflow must own final disposition, review and continuation. Hosts that require a disposition may schedule recovery when an issue remains open; automatic closure is not used to suppress that recovery.

## Configuration

Provide values through Paperclip adapter config or the environment. Copy `.env.example` for local development:

```env
BASE_URL=http://localhost:11434/v1
MODEL=qwen2.5-coder:1.5b
TEMPERATURE=0.7
MAX_TOKENS=2048
AUTO_MARK_DONE=false
ENABLE_PAPERCLIP_ACTIONS=true
```

`SYSTEM_PROMPT` is optional. Config supports uppercase and camelCase aliases, such as `MODEL`/`model`. Explicit config wins over host-resolved `config.env`, then process environment, then defaults. Task options can override only temperature and token limits. See [CONFIGURATION.md](CONFIGURATION.md) for the exact contract, alias policy, result semantics and limitations.

Omit `API_KEY` to use Ollama's public `ollama` placeholder without redacting normal occurrences of that word. Every explicitly supplied key is treated as a secret, including an explicit `API_KEY=ollama`. Credentials must contain only visible ASCII without whitespace; invalid values fail before any request rather than being trimmed or rewritten. An explicit empty key disables model authorization.

Omit `PAPERCLIP_BASE_URL` to use the host runtime URL; set it explicitly only for a trusted destination override. Both service URLs are validated before inference or company lookup. HTTP is allowed only for loopback (`localhost`, `127.0.0.0/8`, `[::1]`); remote services require HTTPS. Embedded credentials, query strings, fragments and malformed values fail configuration with zero outbound requests. All redirects, including same-origin redirects, are rejected. The clients do not inherit Axios credentials, headers, interceptors or proxies; proxy environment variables are intentionally not used. Configure a direct HTTPS endpoint or trusted gateway where needed.

The model list is a convenience list, not a capability certification. Any configured model must support the selected endpoint; delegation additionally needs reliable JSON planning. No native model tools are offered.

`ENABLE_PAPERCLIP_ACTIONS=true` permits company lookup and follow-up creation. For example, “tell CTO to review this” can create a task if CTO resolves to one eligible visible agent and Paperclip authorizes the assignment. It does not transfer the original issue. “Hire a CTO” does not create an agent: hiring and approval handling are unimplemented.

Generic prompts such as “Explain how a JavaScript agent works” do not request company data and work without a Paperclip token. Advice such as “Suggest a workflow for our team” may use optional enrichment; a missing token or failed lookup cannot block its general answer. Explicit reads such as “Who are our agents?” and delegation require authenticated company context and fail if it is unavailable or actions are disabled. Detection remains a limited phrase-based heuristic, not a general natural-language authorization system.

## Installation and external adapter contract

Use Paperclip's **external adapter** installer with the package name, or a built local checkout. Its loader imports the package root and calls `createServerAdapter()`.

Root exports remain:

- `type`, `label`, `models`, `agentConfigurationDoc`
- `createServerAdapter`

The factory returns `execute`, `testEnvironment`, `getConfigSchema`, metadata and `supportsLocalAgentJwt: true`.

The investigation's reference host revision, [879140c](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/server/src/routes/adapters.ts#L332), uses `POST /api/adapters/install` with `packageName` and optional `isLocalPath`. For a local checkout, build first and use an absolute path. Adapter management requires the host's configured administrative access and external-code policy. Check your installed host revision before using its API.

This package is not a general Paperclip plugin. It no longer advertises `paperclipPlugin.manifest`; the old `./manifest` metadata export is retained only for existing importers. Installing through the general plugin/upload workflow is not supported by that legacy manifest. Both npm and local external-adapter loading use the root factory.

Older Windows hosts may fail with `Received protocol 'c:'` when importing a local path. The reference upstream adapter loader uses `pathToFileURL()`; upgrade affected older hosts. This is not a reason to use the general plugin installer.

## Development and verification

```bash
npm ci --ignore-scripts
npm test
npm run build
```

`npm test` builds and runs deterministic regression tests with Node's test runner. Alongside mocked Axios tests, network-boundary tests exercise real Axios serialization with intercepted Node transports. Child processes exercise native HTTP/HTTPS agent selection under Node environment proxy settings (including `--use-env-proxy` where supported), intercepting socket creation before DNS or TLS connection. Tests do not contact Ollama or Paperclip and cannot modify company data.

The former live inference smoke test is separately opt-in:

```bash
npm run test:integration
```

It requires a running Ollama endpoint and the configured model. It supplies no Paperclip token or issue ID and explicitly disables company actions. It validates inference, not persisted delegation or autonomous execution.

Inspect distribution without publishing:

```bash
npm pack --dry-run --ignore-scripts
node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"
```

No new runtime dependencies are needed for the regression suite.

## Remaining limitations

Regex intent detection and JSON delegation planning remain limited; they are not an authorization model. Only exact normalized names/titles/roles are matched. A unique exact name takes precedence; otherwise multiple role/title matches are rejected. Eligible states are `idle`, `active` and `running`; self-assignment, missing/unknown states and other statuses are rejected. Paperclip remains responsible for final permissions and scheduling.

There is no request deadline/cancellation support, replay-safe task creation, full skill/session integration or autonomous execution loop yet. A creation request can persist before a transport failure. The adapter does not retry it, but host recovery policies or operator retries can start another execution. Do not blindly repeat an uncertain action without checking Paperclip state.

## Troubleshooting

- Verify Ollama is running and `BASE_URL` includes its OpenAI-compatible `/v1` path.
- Verify the configured model is available, for example with `ollama list`.
- For a delegation failure, inspect returned action details and Paperclip permissions.
- For truncated responses, raise the output limit or reduce the request; no completion write occurred.
- Tool calls are rejected because this adapter has no tool executor.
- Provider errors retain safe message details and HTTP status. Diagnostic messages are capped at 512 characters; known secrets, sensitive headers/fields and URLs are redacted, and unsafe/oversized content is omitted. Credential classification explicitly separates authentication fields from public sampling settings, so token limits such as `2048` or `1` retain normal output and metadata. Known credential values are also redacted from ordinary logs and invocation metadata, including object keys. Raw response objects and stacks are never used as error messages.
- Malformed optional issue identifiers are omitted while retaining a valid receipt ID. Required IDs and supplied assignment echoes are validated before reporting delegation; arbitrary provider objects never enter action metadata. See the configuration reference for receipt validation and credential/ID collision handling.

## License

MIT
