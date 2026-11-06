# Phase 1 Integration Findings and Phase 2 Execution Prototype

## Rollout status

Keep `DELEGATION_STORAGE` disabled. Phase 1 document reservations prevented duplicate creation in the isolated checks, but the tested Paperclip server had two confirmed server-side reliability defects. The adapter does not repair either defect by repeating ownership reads or retrying writes.

The integration evidence came from synthetic data in a disposable PostgreSQL database and real loopback HTTP routes. The exercised server packages were Paperclip 2026.1023.0 (build commit `1b4c803816e82b0265c8422e1a804327a7ed8c54`) and PostgreSQL 18.2. The harness mounted real routers, authentication middleware, storage, and database services; it did not boot the complete Paperclip application or scheduler. The pinned source checkout was inspected but not executed, so the observations below apply to the exercised build and must be repeated against the intended deployment.

## Confirmed server-side ownership race

The adapter reads the source issue, current agent, and running execution before creating a child issue. Those reads are not an atomic ownership lease.

In the controlled race probe, a database transaction cancelled the original run, marked a replacement run for the same source issue as running, and transferred the source issue's run/checkout ownership fields after the adapter's final reads but before the server handled the creation request. The server accepted the child issue. The adapter then failed its later receipt-persistence eligibility check, returned failure with the confirmed child issue ID retained, and did not replay the creation.

This establishes a time-of-check/time-of-use gap in the tested server creation path. It does not establish that arbitrary actors can bypass normal server authorization. More adapter GET requests cannot close this gap. The server must validate the expected source/run/agent ownership inside the same transaction that creates the child issue, with an appropriate lock or conditional write, and test that transition under concurrency.

## Confirmed document-creation deadlocks

Three 32-way reservation races retained exactly one authoritative document per key, but returned intermittent HTTP 500 responses (6, 1, and 0 across the three runs). PostgreSQL logs identified deadlock cycles involving issue-document insertion and foreign-key key-share locks on issues alongside `heartbeat_runs` row locks. The tested server recognized unique-constraint conflicts, but these deadlocks were separate concurrency failures.

The server should establish and test a consistent lock order and deliberately classify rolled-back deadlock victims. Do not add blind adapter retries. A retry is safe only after the server contract proves the previous transaction rolled back and the reservation state is re-read authoritatively.

## Rollout restrictions and reproduction

The evidence is bounded: real PostgreSQL and HTTP routes were used, but the complete host scheduler, admission/checkout lifecycle, deployed server revision, PostgreSQL crash durability, and actual Ollama competence were not verified. Deletion or authorized tampering with both durable journal records also remains outside the adapter's duplicate-prevention guarantee.

To reproduce the two server findings, use only an isolated test database and synthetic company, agent, source issue, and runs:

1. For the ownership race, let the adapter finish its final ownership reads, atomically cancel its run and transfer the same issue to a replacement run, then allow the real issue-creation route to proceed. Verify the child issue was created and the adapter retained its receipt while reporting the later persistence failure.
2. For document contention, issue 32 simultaneous real HTTP create-document requests for one company/issue/key, inspect HTTP statuses, query the unique-key row, and inspect PostgreSQL deadlock diagnostics. Repeat to observe the intermittent 500 rate.
3. Repeat with the exact Paperclip server, database, and adapter-utils versions intended for deployment before changing the rollout decision.

Keep storage disabled until the server-side ownership gap and concurrency behavior have been fixed or explicitly accepted, and the full host lifecycle has been validated. The prior deterministic adapter suite passed 482 tests; those unit/regression tests do not replace the database and host integration checks above.

## Phase 2 real-execution prototype

The target was a deliberately broken `clamp` function in a small TypeScript fixture. Its fixed `npm test` script failed before the agent run (`1` test, `0` passed, `1` failed; `5` was returned as `0`). The fixture lived only in the ignored disposable test cache. No application source, Paperclip organization, production database, or issue was modified.

The local runtime inventory was Ollama 0.32.5 and OpenCode 1.17.1 on Node 24.11.1. Installed local models included `qwen2.5-coder:1.5b` and `qwen3:4b-instruct`; both were advertised by Ollama as tool-capable. OpenCode used a private temporary config and a local Ollama provider. For the larger-model attempt, the isolated Ollama service had cloud features disabled. The config was deny-by-default and was set to allow edits only to `src/clamp.ts`, only the fixture's `npm test` command, and to deny web access, subagents, and external directories.

The 1.5B OpenCode run exited zero but **did not execute tools**. Its JSON trace contained a text event with fenced JSON naming a nonexistent `inspect-and-fix` tool; there was no actual tool event, the source remained broken, and the agent did not run the test. Independent rerun still failed the fixture test. This is direct evidence that model prose and a zero process exit code are not proof of work.

The invocation is reproducible with the fixture and permission config described above using `opencode run --pure --dir <fixture> --format json --model ollama/qwen2.5-coder:1.5b --agent build <task>`. Check the JSON event types and then independently inspect the allowed file and run `npm test`; do not treat an assistant text event as a tool call.

A second attempt used `qwen3:4b-instruct` with a separate loopback Ollama server, the already-installed model store, cloud disabled, and a 32K context. The OpenCode invocation produced no trace output or verified change within the bounded run and was terminated. A reduced-context service readiness retry also did not establish a completed agent run. No file edit or test success is claimed. The model runner, isolated server, and incidental Ollama app processes started for this investigation were stopped afterward.

The POC therefore **did not demonstrate a working Ollama coding agent**. It showed two blockers in this environment: the smaller model returned tool-like text instead of a callable action, and the larger model/harness attempt did not complete within available local resources. Ollama reported CPU-only inference and about 2 GiB of available system memory at startup. This should not be generalized into a claim that OpenCode or Qwen cannot work elsewhere.

OpenCode permissions were configured but their enforcement was not exercised because the model never made a callable tool request. No OS-level sandbox or firewall egress restriction was used for the POC; harness rules alone are not a kernel boundary. No credential access or external tool request is claimed to have been tested.

## Harness comparison and integration boundary

Paperclip's built-in `opencode_local` is a separate adapter that launches the OpenCode CLI (`opencode run --format json`) with a `provider/model` selection and session support. Its Ollama provider is configured in OpenCode's own provider configuration; this does not add file or shell tools to this external Mavwu adapter. Paperclip's unattended OpenCode configuration can allow all tools through `dangerouslySkipPermissions`, so a disposable workspace and OS-level isolation remain important. OpenCode's own Ollama guidance recommends a larger context when tool calls fail. See the [Paperclip OpenCode adapter](https://github.com/paperclipai/paperclip/blob/master/packages/adapters/opencode-local/src/index.ts), [Paperclip OpenCode documentation](https://github.com/paperclipai/paperclip-docs/blob/main/docs/reference/adapters/opencode.md), and [OpenCode provider configuration](https://docs.opencode.ai/docs/providers/).

Paperclip's built-in `pi_local` launches the Pi coding-agent CLI rather than the Mavwu adapter. The inspected Paperclip implementation passes provider/model, a session path, configured skills, and its default `read,bash,edit,write,grep,find,ls` tool set; it also uses Paperclip's process timeout/result handling. Pi supports an Ollama-compatible OpenAI endpoint through its own `models.json` configuration. Pi is not installed on this machine, so that path was not executed. Its default bash tool is broad; tool selection alone is not a command sandbox. See the [Paperclip Pi adapter](https://github.com/paperclipai/paperclip/blob/master/packages/adapters/pi-local/src/server/execute.ts) and [Pi's local-compatible model setup](https://pi.dev/docs/latest/models).

Integrating either harness into Mavwu would require Mavwu to spawn and supervise the CLI in Paperclip's prepared workspace, pass only authorized task context, enforce file/command/network boundaries, propagate cancellation and deadlines, handle sessions, parse real tool and test outcomes, and preserve truthful host results. Building an in-adapter tool loop would additionally duplicate model tool-call parsing, command execution, path confinement, cancellation, output limits, and evidence validation. Neither change is justified until one established harness completes the fixture under the intended model and security boundary.

The full Paperclip host lifecycle was not exercised in this prototype. Cached Paperclip server and built-in adapter packages were 2026.1023.0, while this project's installed adapter-utils is 2026.609.0; the previously inspected source checkout and cached server build are not assumed to be compatible. No host run, Paperclip task mutation, checkout, skill invocation, or agent execution was created. `DELEGATION_STORAGE` remains disabled.

## Recommended next milestone

Keep Mavwu inference-only and use Paperclip's existing `opencode_local` or `pi_local` adapter for workspace execution when a verified local model/harness pair is available. Do not add a second tool runtime to Mavwu yet. First rerun the fixture in a supported isolated host with a tool-capable model whose context fits the machine, record actual tool-call events, inspect the diff, and run the test independently. Enable no delegation storage as part of that experiment.

## Evidence and cleanup

The raw traces, fixture, and logs remain under an ignored disposable cache directory for local audit; the checked-in project note intentionally omits machine-specific paths, credentials, tokens, IDs, and secrets. The only source-tree change for this investigation is this documentation note and its README link. No adapter code was changed, so the 482-test suite was not rerun for this documentation-only update.
