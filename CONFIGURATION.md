# Adapter Configuration Reference

The adapter calls Ollama's OpenAI-compatible chat-completions endpoint. Configuration comes from Paperclip adapter config, process environment, or a local `.env` file loaded by dotenv.

## Fields

| Variable | camelCase | Default |
| --- | --- | --- |
| `BASE_URL` | `baseUrl` | `http://localhost:11434/v1` |
| `API_KEY` | `apiKey` | `ollama` |
| `MODEL` | `model` | `qwen2.5-coder:1.5b` |
| `TEMPERATURE` | `temperature` | `0.7` |
| `MAX_TOKENS` | `maxTokens` | `2048` |
| `MODEL_REQUEST_TIMEOUT_MS` | `modelRequestTimeoutMs` | `120000` |
| `PAPERCLIP_REQUEST_TIMEOUT_MS` | `paperclipRequestTimeoutMs` | `30000` |
| `EXECUTION_TIMEOUT_MS` | `executionTimeoutMs` | `300000` |
| `TIMEOUT_SEC` | `timeoutSec` | `0` (no additional cap; adapter deadline stays active) |
| `SYSTEM_PROMPT` | `systemPrompt` | Agent identity/truthful-response instructions from `src/metadata.ts` |
| `AUTO_MARK_DONE` | `autoMarkDone` | `false` (deprecated; no completion writes) |
| `PAPERCLIP_BASE_URL` | `paperclipBaseUrl` | Host runtime URL, otherwise derived host/port (`http://localhost:3100`) |
| `ENABLE_PAPERCLIP_ACTIONS` | `enablePaperclipActions` | `true` |

Configuration precedence is:

1. Explicit fields on the host-supplied `context.config`.
2. The host-resolved agent environment object, `context.config.env`.
3. Process environment (including dotenv values, which do not override existing process values).
4. Adapter defaults.

Each layer checks uppercase aliases before camelCase aliases. A higher-layer camelCase value wins over a lower-layer uppercase value. On Windows, environment names differing only by case share a single OS entry (`MODEL`/`model`, `TEMPERATURE`/`temperature`); their last OS assignment wins before adapter normalization. Plain configuration objects can contain both spellings and use the stated uppercase-first policy.

Only `TEMPERATURE`/`temperature` and `MAX_TOKENS`/`maxTokens` are permitted task overrides. `context.task.options` is applied first, then `context.options`, normalizing aliases independently at each step. Other options are ignored, including `env`, `MODEL`, `SYSTEM_PROMPT`, credentials, destinations, runtime skills and action/completion flags. Task options are not a trusted environment source. Temperature must be finite and between 0 and 2; max tokens must be a positive safe integer. Invalid selected configuration fails rather than falling through to a lower-priority value. An explicit empty API key omits model authorization, and an empty system prompt omits the system message.

For the Paperclip destination, the existing adapter-specific `PAPERCLIP_BASE_URL`/`paperclipBaseUrl` override follows those same three configuration layers. If absent, host process `PAPERCLIP_API_URL` wins, followed by `PAPERCLIP_RUNTIME_API_URL`. Otherwise the adapter mirrors current upstream host/port derivation: `PAPERCLIP_LISTEN_HOST` or `HOST`, and `PAPERCLIP_LISTEN_PORT` or `PORT`, with localhost/3100 defaults. Wildcard hosts map to localhost. Reserved `config.env.PAPERCLIP_API_URL` cannot override that host runtime URL. Neither process nor agent `PAPERCLIP_API_KEY` can supply Paperclip identity: only `context.authToken` is used.

Example:

```env
BASE_URL=http://localhost:11434/v1
MODEL=qwen2.5-coder:1.5b
TEMPERATURE=0.7
MAX_TOKENS=2048
AUTO_MARK_DONE=false
ENABLE_PAPERCLIP_ACTIONS=true
```

## URL and credential boundaries

Both endpoints must be absolute HTTP(S) base URLs with a nonempty raw authority immediately after exactly two scheme slashes. HTTPS supports secure remote services; HTTP is restricted to exact localhost, parsed IPv4 literals in 127.0.0.0/8 and IPv6 ::1 (including expanded spelling normalized by the URL parser). Deceptive DNS names such as `127.attacker.invalid` are rejected. IPv4-mapped IPv6 addresses are not supported for HTTP. Usernames/passwords (including an empty user-info marker), excess authority slashes, query strings, fragments, backslashes and embedded whitespace/controls are rejected before URL normalization can hide malformed syntax. Base paths are supported, for example `https://gateway.example/model/v1` or `https://gateway.example/paperclip`. Absent URLs use the defaults above; explicit empty, null, wrong-type or malformed URLs fail with `INVALID_CONFIGURATION` before any outbound request, even when that service would otherwise be optional or disabled. Omit an optional override rather than setting it blank.

Model completion, delegation planning and the environment probe share the model client. It receives only the configured model key. Agent lookup and issue creation share a separate Paperclip client using only the host's run token. Clients expose adapter-owned operations, not arbitrary URL/header/request-config passthrough. Ambient Axios Basic auth, headers, parameters and interceptors are not inherited. Ambient HTTP(S) proxies are disabled at both Axios and Node agent layers: private direct HTTP and HTTPS agents avoid the global agents, including Node's `--use-env-proxy` / `NODE_USE_ENV_PROXY` behavior. The Node HTTP transport uses `maxRedirects: 0`, rejects every 3xx response, and explicitly verifies HTTPS certificates; no redirect request or automatic replay follows. Use a direct service URL or a trusted HTTPS gateway rather than configuring a redirect or ambient proxy.

Both bearer credentials must be nonempty visible ASCII (0x21 through 0x7e) when present. Whitespace, controls, non-ASCII and malformed Unicode are rejected before any request; credentials are never trimmed or repaired. An absent/empty run token cannot authorize Paperclip requests. An explicitly empty model key omits model authorization.

Known supplied credential values are redacted from ordinary stdout/stderr and invocation metadata as well as error diagnostics. The implicit public `ollama` default is not collected as a secret, so normal Ollama answers and command metadata retain that word. Explicit credentials from configuration, agent environment or process environment are still treated as secrets, even if the value is `ollama`; omit that setting to use the public default. The schema and examples leave the placeholder implicit. Previously stored explicit placeholder values retain explicit-secret behavior. This is a diagnostic safeguard, not a substitute for keeping secrets out of user/task text. The adapter never injects the Paperclip token into a model prompt.

Credential discovery uses the explicit credential classes in `src/server/diagnostics.ts`, with camelCase/uppercase normalization and vendor/scope prefixes. These include API keys, authentication/access/session tokens, secrets, passwords, private/signing keys, authorization and cookies. It does not infer a credential from a substring alone. Public sampling controls, token limits/counts/budgets and temperatures are excluded; string values such as `MAX_TOKENS=2048` or task `maxTokens="1"` do not redact those numbers from answers or metadata. Actual credentials remain secrets even when their value is numeric. Labeled provider diagnostics use the same classification policy, and metadata redaction covers both keys and values. Unrecognized custom credential names require extending the explicit policy; no heuristic can identify every arbitrary secret embedded in text.

## Integration contract and compatibility

The baseline dependency remains `@paperclipai/adapter-utils` **2026.609.0**, unchanged by this batch. Its `AdapterExecutionContext` provides `config` and separate `authToken`; no `runtime.env` or task-provided authentication contract is assumed. In the official source, the host resolves environment/secrets before passing `runtimeConfig` as `config`, and built-in adapters read `config.env`. The host mints the local run JWT when `supportsLocalAgentJwt` applies. Trust in `config`/`config.env` therefore depends on the host's configuration and secret-access controls; adapters cannot independently attest who authored those settings.

Source references inspected before implementation:

- [Configuration preparation](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/server/src/services/heartbeat/execution-configuration.ts#L185).
- [Run token and adapter invocation](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/server/src/services/heartbeat/runtime-execution.ts#L261).
- [Built-in environment consumption](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/packages/adapters/pi-local/src/server/execute.ts#L283).
- [Current upstream runtime URL and environment protections](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/packages/adapter-utils/src/server-utils.ts#L3231).

The installed utility helper gives `PAPERCLIP_RUNTIME_API_URL` priority over `PAPERCLIP_API_URL`; inspected current upstream gives the explicit `PAPERCLIP_API_URL` priority. This adapter deliberately follows the latter order directly and tests it. The package's root external-adapter factory and declared dependency version are preserved. Verified newer cancellation/dispatch fields are consumed as optional structural extensions only when the host actually supplies them; their presence is not assumed on older hosts.

## Execution deadlines and host lifecycle

All three millisecond settings follow the same trusted configuration precedence and uppercase/camelCase alias policy. They must be finite safe integers from 1 to 86400000. Empty, null, nonnumeric, fractional, zero, negative or oversized values fail with `INVALID_CONFIGURATION` before readiness registration or HTTP work. Task options cannot override deadlines, callbacks or cancellation channels. The official `timeoutSec` configuration setting is supported as an additional trusted overall cap: 0 keeps the adapter's bound, a positive value tightens it, and invalid/negative values fail. Seconds must resolve to integral milliseconds and cannot exceed 86400. The sandbox command-default timeout helper is not used because this adapter does not execute sandbox/SSH commands.

The overall monotonic budget starts at entry to execute and spans lookup, planning, writing, inference and callback checkpoints. Every request has its own wall-clock AbortController timer, a native Axios timeout bounded by remaining run time, and a child signal linked to the run stop signal. These limits include connection/response waits rather than relying solely on socket inactivity. A shorter optional company-read deadline records a failed optional action but still permits a general answer while the run budget remains. A required lookup timeout fails instead of invoking the model to guess company state. The environment probe uses the shorter of its existing 30-second limit, configured model request timeout, and overall budget.

Official lifecycle evidence inspected for this batch:

- [Optional cancellation and dispatch interfaces](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/packages/adapter-utils/src/types.ts#L240).
- [Host signal, readiness registration and dispatch notification](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/server/src/services/heartbeat/runtime-execution.ts#L885).
- [Cancellation ownership/settlement](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/server/src/services/adapter-execution-control.ts#L53).
- [Host cancellation/timeout outcome selection](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/server/src/services/heartbeat/run-completion.ts#L427).
- [Host work-mode context projection](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/server/src/services/heartbeat/task-context.ts#L336).
- [Host issue-admission ownership checks](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/server/src/services/heartbeat/queue.ts#L1049).

Installed adapter-utils 2026.609.0 declares none of `signal`, `onCancellationReady` or `onDispatch`. A local structural type mirrors the verified optional upstream fields without changing dependencies or requiring them from an older host. Only the top-level host context is consumed; task options cannot forge those capabilities. Readiness is awaited once after configuration/credential validation and cancellation wiring, before any HTTP request. Its callback requires a host signal; cancellation during registration is rechecked. Synchronous `onDispatch` is called once immediately before the first actual HTTP attempt, including an enrichment lookup, and stop state is checked again before dispatch. Readiness/dispatch exceptions or unsupported callback contracts fail with `ADAPTER_LIFECYCLE_FAILED` and no further network request. No process spawn is fabricated.

Host cancellation produces `errorCode: "cancelled"`, `resultJson.status: "cancelled"`, `stopReason: "cancelled"`, and `timedOut: false`. Model/Paperclip request deadlines use `MODEL_REQUEST_TIMEOUT` / `PAPERCLIP_REQUEST_TIMEOUT`; the run budget uses `EXECUTION_DEADLINE_EXCEEDED`. A failed run timeout has `timedOut: true` and `stopReason: "timed_out"`. All remain unsuccessful executions with `workflowCompleted: false`; an optional enrichment timeout alone does not turn a successful answer into a timed-out run. No transient retry family, retry timestamp, bootstrap recovery authorization or verified-provider-stop claim is emitted. Host abort reasons are never copied into diagnostics. The first run-level stop cause is retained; the host may independently make a later cancellation authoritative in its own finalization.

Local HTTP abort and promise settlement do not prove that a remote provider stopped computing or rolled back a write. The adapter awaits owned HTTP operations and host callbacks until they settle, checks stop state after callbacks and before further work, and cleans up request/run timers and abort listeners. A noncooperative host callback/transport or blocking JavaScript cannot be forcibly preempted: this is a cooperative execution budget, not a hard process-kill deadline. It deliberately does not race an uncooperative write and return while adapter code continues to create effects in the background. Remote computation termination, bounded provider payload sizes and hard host-process enforcement remain separate work.

## Write persistence and ownership

Delegation action records distinguish `persistence: "confirmed"`, `"rejected"`, `"unknown"`, or `"not_attempted"`. A valid 2xx issue receipt confirms creation; an assignment mismatch still retains that creation receipt but fails the requested delegation. A received receipt is captured before Axios's post-response cancellation check, so a later stop cannot erase it. If a request deadline or cancellation accompanies that receipt, the run reports the stop while retaining the confirmed action. Malformed successful receipts, transport failures, HTTP 5xx, blocked redirects, HTTP 408 and HTTP 499 remain uncertain: the origin may already have persisted a write. Other 4xx responses are recorded as API rejections according to normal HTTP semantics. No status is independent proof of a dishonest server's internal transaction state.

No request is automatically replayed. An uncertain write is unsuccessful, explicitly warns that creation may have persisted, and requires state inspection before retrying. Cancellation/timeout results preserve earlier action receipts; stopping the run does not undo confirmed effects. Host/operator recovery must honor that uncertainty; idempotency and reconciliation are not implemented in this batch.

Paperclip owns admission, authorization, issue execution ownership and checkout. The official task projection supplies a work mode but not a general adapter ownership/checkout lease. This adapter never checks out, completes or mutates source-issue status, and it does not infer ownership from a prompt or acquire a competing lease. Explicit delegation is blocked when `paperclipIssue.workMode` is present and not `standard`, or when the host projects a skill-test JWT scope. Ordinary text and eligible reads remain available; absent legacy mode information retains the previous behavior under API authorization. This is only a restriction on unsupported writes, not skills integration. Full checkout/disposition, recovery/reconciliation, sessions and autonomous execution remain later work.

Planning-mode approval continuations are intentionally still unsupported here: this adapter does not verify plan-approval authority or perform plan conversion. The official host can provide richer [ask/planning directives](https://github.com/paperclipai/paperclip/blob/879140cbbde40d228104adb062bd020f4ba3a139/server/src/services/heartbeat/task-markdown.ts#L238); this conservative write restriction must not be mistaken for a claim that the host universally forbids approved planning handoffs.

## Issue disposition

No response or delegation automatically marks an issue done. `AUTO_MARK_DONE` remains parsed for compatibility, but a true value only changes the reported disposition reason to `completion_not_verified`. False reports `disabled`. Both have `attempted: false` and perform no status write.

This deliberately applies to apparently finished answers, blocked responses, plans, and successful or failed delegations. A one-shot model reply is not task-completion evidence. Paperclip or another capable workflow must handle checkout, completion, review, blockers and continuation. Some hosts may schedule missing-disposition recovery runs; an operator must account for that when choosing this adapter.

## Results

- Usable model text: `exitCode: 0`, `success: true`, `stopReason: "response_received"`.
- Confirmed follow-up creation: `exitCode: 0`, `success: true`, `stopReason: "delegated"`, with the returned issue ID in `actions`.
- Failure: `exitCode: 1`, `success: false`, `stopReason: "failed"`, plus `errorCode` and error details.
- Cancellation: `exitCode: 1`, `success: false`, `stopReason: "cancelled"`, `status: "cancelled"`, `errorCode: "cancelled"`, and `timedOut: false`.
- Required timeout: `exitCode: 1`, `success: false`, `stopReason: "timed_out"`, `timedOut: true`, and the specific request/run deadline error code.
- `success` and `stopReason` are fields of `resultJson`; `exitCode` and `errorCode` are also top-level adapter result fields.
- `workflowCompleted` is always `false`; generating text and creating a task do not prove the source task's completion.

A valid blocked or planning reply can be a successful inference response without being completed work. A declined delegation is a failed requested action. An unverified creation receipt is a failure; the request may already have persisted, so check state before retrying.

Issue receipts require a nonblank scalar string ID without surrounding whitespace, unsafe controls/markup or known credential values. Supplied assignment echoes must be matching strings; legacy receipts may omit that echo. Invalid IDs fail without persisting arbitrary response data; an assignment mismatch preserves a safe issue ID but does not claim successful delegation. Optional `identifier` must be nonblank text of at most 512 characters without unsafe controls/markup; malformed values are omitted as null while preserving an independently valid issue ID. Valid display identifiers and assignee names are redacted before persistence. Other provider response fields are never copied into action metadata. Credential-bearing assignee IDs are rejected before issue creation. A real credential that collides with an opaque ID can therefore make that ID unverified; use a distinct credential or inspect Paperclip state rather than retrying blindly.

Optional enrichment is distinct from a requested organizational action: an unavailable optional lookup is recorded as `success: false`, `required: false` in `actions`, while a usable general answer remains `response_received`. Required lookup failures still fail the execution and do not invoke the model to guess company state.

Stable inference errors include `OLLAMA_EMPTY_RESPONSE`, `OLLAMA_TRUNCATED_RESPONSE`, `OLLAMA_INCOMPLETE_RESPONSE`, `OLLAMA_REFUSAL`, and `OLLAMA_UNSUPPORTED_TOOL_CALL`. Provider request failures use `OLLAMA_ERROR_<status>` or `OLLAMA_CONNECTION_ERROR`. Delegation failures use `PAPERCLIP_DELEGATION_FAILED`; required company lookup failures use `PAPERCLIP_CONTEXT_FAILED`. Explicit organizational requests with actions disabled use `PAPERCLIP_ACTIONS_DISABLED`. Unexpected adapter/callback failures use `ADAPTER_EXECUTION_FAILED`.

Provider diagnostics support `error.message`, string `error`, `message`, `detail`, plain text and JSON text bodies. For example, a safe 404 message becomes `HTTP 404: Requested model is not installed`. Only those message fields are inspected; response/config objects, headers, stacks, causes and arbitrary object string conversions are not dumped. Messages are capped at 512 characters after redacting known configured/environment secrets and sensitive header/field values. URLs are omitted; HTML, terminal controls, stack traces and oversized bodies are replaced with a safe notice. The same formatting applies to company API failures, planner exceptions and environment diagnostics.

## Company actions and assignment

With actions enabled, company reads and delegation use the run's supplied JWT. Generic terms such as “agent”, “company” and “team” alone do not request organizational data. Explicit reads, including “Who are our agents?”, “Show our org chart” and “Who is our CTO?”, require company context. General advice referring to “our team” can use optional enrichment; missing authentication or lookup failure only adds a context-unavailable warning to the inference prompt. No unauthenticated fallback API request is made. An explicit organizational operation fails if authentication/context is unavailable or company actions are disabled.

The original request is selected from source context before rendering company information or historical task text. An injected company appendix cannot activate delegation planning. Phrase-based detection is intentionally limited; broader intent and trust handling remain future integration work.

For explicit delegation, one JSON plan is requested using only that original request and the visible-agent list. Invalid JSON/types, truncated output or planner refusal fail explicitly; there is no silent successful-chat fallback. The plan can create one new `todo` follow-up linked to the source issue. It does not reassign the source or implement dependency graphs.

Matching is case-insensitive and exact after trimming the requested name. A unique exact name takes precedence over role/title matches; duplicate names or multiple role/title matches are rejected. Substring matching is not used. The selected agent must differ from the executing agent and have status `idle`, `active` or `running`. Paused, pending approval, terminated, error, missing and unknown states are rejected. A running agent remains eligible because assignment does not itself guarantee immediate execution or limit concurrency; Paperclip governs admission and scheduling.

No agent is created by a hiring prompt. Hiring permissions, agent configurations, approval requests and approval continuation are not implemented. Disabling actions leaves generic text inference available; explicit supported organizational reads/delegation fail instead of being simulated through chat.

## Request and response validation

The inference payload contains `model`, `messages`, `temperature`, `max_tokens`, and `stream: false`. There is no `tools` array or action loop.

User-visible text can come from:

- `choices[0].message.content`
- `choices[0].text` (legacy completion)
- `message.content` (native-style response)
- `response` (native-style generation)

Missing/blank text fails. Reasoning fields are not substituted for final content. Truncation (`length`), refusal, tool/function calls, a false native `done`, and nonterminal/unsupported finish reasons fail. Compatible endpoints without a finish-reason field remain supported when usable final text exists; that still cannot authorize completion.

The environment probe uses the same validator, capped at 30 seconds and further bounded by configured request/run deadlines. A passed probe verifies usable text inference only, not Paperclip permissions, tool use or autonomous work.

## Context, skills and sessions

The rendered inference prompt still uses the existing wake/task extraction paths. A wake comment is prioritized and historical task text is retained as background. Broader structured wake/approval context preservation remains integration work.

`paperclipRuntimeSkills` is parsed but not delivered or synchronized. `Paperclip-skills/` is not shipped as a runtime skill package. Session fields are passed through, but conversation history is not restored or updated. No managed instructions bundle, filesystem tools or shell execution is provided.

## Tests and installation

`npm test` builds and runs the deterministic regression suite. Tests include mocked Axios calls, real Axios request/header serialization with intercepted Node transports, and native Node agent selection in child processes with final TCP/TLS socket constructors intercepted before network activity. A Socket.connect guard also intercepts previously captured connection functions. Each proxy-mode test uses a global-agent positive control to prove activation, then reports which mode was exercised. Unsupported `--use-env-proxy`, or an environment mode that does not activate on that Node version, is explicitly reported as skipped/unverified rather than passed. They do not perform DNS lookups, real TLS handshakes or external service calls. `npm run test:integration` separately runs an opt-in real model smoke test with company actions disabled and no company credentials or issue ID.

Lifecycle tests use controlled abort-aware transports, real Axios with intercepted native requests, timer mocks and a monotonic clock mock. Clock-specific cases explicitly skip as unverified if the Node test runner lacks compatible mocking APIs. The full suite is verified on Windows with Node 24.11.1; the package runtime engine remains Node >=18, but this does not imply every older Node test-runner feature was exercised.

Use the external adapter installer, which imports the package root's `createServerAdapter`. The package no longer declares `paperclipPlugin.manifest`. The retained `./manifest` export is legacy metadata, not a valid current general-plugin manifest. See [README.md](README.md) for the pinned host reference and installation details.
