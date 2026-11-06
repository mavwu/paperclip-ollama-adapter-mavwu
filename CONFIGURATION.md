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
| `SYSTEM_PROMPT` | `systemPrompt` | Agent identity/truthful-response instructions from `src/metadata.ts` |
| `AUTO_MARK_DONE` | `autoMarkDone` | `false` (deprecated; no completion writes) |
| `PAPERCLIP_BASE_URL` | `paperclipBaseUrl` | `http://127.0.0.1:3100` |
| `ENABLE_PAPERCLIP_ACTIONS` | `enablePaperclipActions` | `true` |

The current alias resolution checks each uppercase config/environment pair before its camelCase pair. Consequently, an uppercase environment value can override a camelCase agent setting. Use uppercase adapter config keys for explicit overrides until precedence is corrected in the integration phase. Nested `config.env` and the standard `PAPERCLIP_API_URL` are not consumed by this config reader; set `PAPERCLIP_BASE_URL` explicitly when the host is not on the default address.

Task `context.options` and `context.task.options` can override adapter config. Restrict who supplies those fields. These Phase 0 changes do not redesign configuration trust or credentials.

Example:

```env
BASE_URL=http://localhost:11434/v1
API_KEY=ollama
MODEL=qwen2.5-coder:1.5b
TEMPERATURE=0.7
MAX_TOKENS=2048
AUTO_MARK_DONE=false
PAPERCLIP_BASE_URL=http://127.0.0.1:3100
ENABLE_PAPERCLIP_ACTIONS=true
```

## Issue disposition

No response or delegation automatically marks an issue done. `AUTO_MARK_DONE` remains parsed for compatibility, but a true value only changes the reported disposition reason to `completion_not_verified`. False reports `disabled`. Both have `attempted: false` and perform no status write.

This deliberately applies to apparently finished answers, blocked responses, plans, and successful or failed delegations. A one-shot model reply is not task-completion evidence. Paperclip or another capable workflow must handle checkout, completion, review, blockers and continuation. Some hosts may schedule missing-disposition recovery runs; an operator must account for that when choosing this adapter.

## Results

- Usable model text: `exitCode: 0`, `success: true`, `stopReason: "response_received"`.
- Confirmed follow-up creation: `exitCode: 0`, `success: true`, `stopReason: "delegated"`, with the returned issue ID in `actions`.
- Failure: `exitCode: 1`, `success: false`, `stopReason: "failed"`, plus `errorCode` and error details.
- `success` and `stopReason` are fields of `resultJson`; `exitCode` and `errorCode` are also top-level adapter result fields.
- `workflowCompleted` is always `false`; generating text and creating a task do not prove the source task's completion.

A valid blocked or planning reply can be a successful inference response without being completed work. A declined delegation is a failed requested action. An unverified creation receipt is a failure; the request may already have persisted, so check state before retrying.

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

The environment probe uses the same validator, with its existing 30-second request timeout. A passed probe verifies usable text inference only, not Paperclip permissions, tool use or autonomous work.

## Context, skills and sessions

The rendered inference prompt still uses the existing wake/task extraction paths. A wake comment is prioritized and historical task text is retained as background. Broader structured wake/approval context preservation remains integration work.

`paperclipRuntimeSkills` is parsed but not delivered or synchronized. `Paperclip-skills/` is not shipped as a runtime skill package. Session fields are passed through, but conversation history is not restored or updated. No managed instructions bundle, filesystem tools or shell execution is provided.

## Tests and installation

`npm test` builds and runs the deterministic regression suite; all Axios requests use an in-memory transport. `npm run test:integration` separately runs an opt-in real model smoke test with company actions disabled and no company credentials or issue ID.

Use the external adapter installer, which imports the package root's `createServerAdapter`. The package no longer declares `paperclipPlugin.manifest`. The retained `./manifest` export is legacy metadata, not a valid current general-plugin manifest. See [README.md](README.md) for the pinned host reference and installation details.
