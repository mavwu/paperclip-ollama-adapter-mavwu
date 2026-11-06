# Live Mavwu inference smoke test — 2026-11-06

Baseline and current HEAD: ae810311fc6f6eee761a5317d239ce1842a1ba13. Sandbox preparation and autonomous coding experiments were paused. No Windows feature/firewall/software changes, model tools or Paperclip host were involved. Existing reports and evidence were preserved.

## Actual adapter execution

Imported createServerAdapter from the built package root and invoked its execute member using AdapterExecutionContext fields from installed @paperclipai/adapter-utils 2026.609.0: runId, agent, runtime, config, context, onLog and onMeta. No Paperclip token or issue ID was supplied. Configuration explicitly disabled actions, auto completion and delegation storage. The separate cancellation checks used the adapter's already-implemented optional lifecycle extension; these signal fields are not declared by installed June adapter-utils and remain host-version-dependent.

Runtime: Node 24.11.1, Ollama 0.32.5, existing local qwen2.5-coder:1.5b. An isolated loopback Ollama server used the existing model store, cloud disabled, a 2K context and one request slot. Native preload requested two CPU threads, batch 64 and CPU-only execution. OpenAI endpoint runtime defaults may differ from native preload options, as established in the earlier protocol investigation. No new model or dependency was downloaded.

Prompt: What is 17 plus 25? Answer in one short sentence.

Real Node HTTP request observation retained the adapter's actual Axios transport and private agents; it did not mock provider responses. The observer recorded method/destination/body/status/response and rejected any unexpected destination before transmission. It did not record authorization values. All five adapter requests were POST /v1/chat/completions to the isolated Ollama service. Pre-cancellation sent no request. There were no company lookups, issue creations, completion requests, retries or other destinations. All request bodies were text inference without tools.

The successful request received HTTP 200, finish_reason stop, content `42`, and usage 67 input / 3 output tokens. The adapter summary exactly equalled the actual provider content. Runtime was 5.394 seconds, excluding preload. Adapter result:

```json
{
  "exitCode": 0,
  "timedOut": false,
  "summary": "42",
  "resultJson": {
    "success": true,
    "stopReason": "response_received",
    "workflowCompleted": false,
    "disposition": {"attempted": false, "reason": "disabled"},
    "actions": []
  }
}
```

## Live failure and stop checks

| Case | Adapter latency | Observed truthful outcome |
|---|---:|---|
| Nonexistent model | 81 ms | Real HTTP 404; exitCode 1, success false, OLLAMA_ERROR_404; meaningful model-not-found message retained |
| Already-cancelled signal | 2 ms | No request; exitCode 1, cancelled, timedOut false |
| Cancel after actual request was sent | 27 ms | Actual Axios request aborted with ERR_CANCELED; cancelled, success false, timedOut false |
| 10 ms model request deadline | 14 ms | MODEL_REQUEST_TIMEOUT, timedOut true, success false |
| 10 ms overall deadline | 14 ms | EXECUTION_DEADLINE_EXCEEDED, timedOut true, success false |

Every result retained workflowCompleted false, empty actions and an unattempted disposition. Local HTTP abort does not prove remote computation stopped; test server/runner processes were terminated afterward. No host retry policy was exercised because no full Paperclip host was launched.

## Verification

- Complete deterministic suite: 482 passed, 0 failed/cancelled/skipped.
- TypeScript build: passed; separate no-emit check: passed.
- npm pack dry-run, scripts disabled: passed, 27 files. No tarball was published.
- Tracked whitespace check and new documentation whitespace checks: passed.
- Actual package-root factory and execution path exercised; no new execution interface invented.
- Server/runner process-tree cleanup succeeded; final listener absence checked.

Raw request/response ledger, full adapter results, logs/metadata, deterministic-test output, package dry-run and the standalone diagnostic script are saved separately in the ignored live-inference evidence directory. No existing investigation artifact was overwritten.

## Release assessment

Local inference works and an inference-only release is technically feasible. This result does not certify autonomous execution, skills/session delivery or full Paperclip scheduler/checkout/recovery compatibility. The model's earlier native tool-call failure is irrelevant to this successfully exercised text-only path.

Confirmed packaging issue to resolve before publishing: README's uncommitted investigation link targets docs/phase-1-integration-findings-and-phase-2-poc.md, while package.json includes only dist, README.md and CONFIGURATION.md. The actual dry-run contains no docs/ files, so that link is broken in the npm artifact. Either package the approved relevant reports or put the operational warnings in shipped documentation and use a repository URL. No packaging/application fix was made in this verification task.

Documentation also needs a concise current inference-only support statement, the actual live result, explicit prohibition on production delegation activation pending server findings, and migration notes for rejected credentials/endpoints/proxies and delegation opt-in. Earlier chronological reports must be retained, with newer successful native/OpenAI findings linked so historical failures do not read as the latest verdict.

Compatibility limits requiring release notes or validation:

- Tested runtime is Node 24.11.1. Declared node >=18 support has not been established by this run; run the supported Node matrix or narrow the supported range deliberately before claiming it.
- Installed adapter-utils is 2026.609.0; optional cancellation readiness/dispatch/signal support depends on newer hosts supplying those structural fields. Factory export and type build pass, but full installed-host plugin loading and retry behavior were not tested here.
- Only loopback HTTP or remote HTTPS endpoints are accepted, redirects and ambient proxies are rejected, credentials must meet the validated character policy. Legitimate deployments depending on the earlier permissive settings need migration guidance.
- Text inference has no file/shell tools, skill runtime or maintained conversation history. No full agent capability should be advertised.
- Keep DELEGATION_STORAGE disabled. Confirmed server-side ownership races and document deadlocks still block production delegation approval; they do not block this isolated inference mode.

Recommended release sequence: review/resolve the documentation packaging issue; approve shipped inference-only warnings and migration notes; verify Node/host support claims; choose a version after checking registry history; synchronize package.json, package-lock.json and legacy manifest version; rerun verification and inspect the exact tarball contents; obtain explicit publish authorization. Recommend a 2.0.0 safety release if replacing the earlier permissive 1.0.x behavior, rather than presenting changed delegation/configuration contracts as an entirely compatible patch. Current local version remains 1.0.10; registry latest/version availability was not established by this smoke test.

No application defect was demonstrated, so application code was not modified. This report is new uncommitted documentation. Existing README changes and prior untracked reports remain intact; nothing is staged or committed. No push, publication or deployment occurred.
