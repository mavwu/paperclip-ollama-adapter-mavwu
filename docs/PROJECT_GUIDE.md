# Paperclip Ollama Adapter: implementation guide

A TypeScript external adapter connecting the Paperclip agent contract to Ollama's OpenAI-compatible chat-completions interface.

## Scope

**Repository role:** Integration package.

Adapter contract compatibility, model capability, and local Ollama availability are separate concerns. Package builds do not establish that every model supports every tool request.

## Local evaluation

Run a static server from the repository root:

```sh
python -m http.server 4173
```

Open `http://localhost:4173` and select the relevant HTML page or variant directory. No build step is required for plain HTML/CSS/JavaScript. Use a server when scripts fetch local content; opening a file directly can produce different behavior.

## Code map

| Path | Responsibility |
| --- | --- |
| `src` | Editable implementation source |

## Configuration

`.env.example`: `BASE_URL`, `API_KEY`, `MODEL`, `TEMPERATURE`, `MAX_TOKENS`, `SYSTEM_PROMPT`, `AUTO_MARK_DONE`, `PAPERCLIP_BASE_URL`, `ENABLE_PAPERCLIP_ACTIONS`

Example files document variable names, not production values. Keep credentials and operator keys outside Git.

## Walkthrough

Build and run the documented contract test, then perform one local request using a known installed model and inspect failure behavior when Ollama is unavailable.

## Verification

From `.`: `npm run test`, `npm run build`.

These are evaluation commands, not a claim that all checks passed. See the pull request validation for checks actually executed in this maintenance pass.

## Evidence for a case study

Describe this repository as a **integration package**. A useful case study explains the problem above, traces the walkthrough to its source, names a concrete implementation decision, and records a repeatable evaluation. Separate implemented behavior from roadmap work. Capture screenshots using synthetic data and identify the demonstrated commit.
