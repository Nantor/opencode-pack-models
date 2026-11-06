# OpenCode Pack Models

**OpenCode Pack Models** (`opencode-pack-models`) is an Effect-native OpenCode V2 server plugin that lets you group multiple LLMs into virtual **Model Packs** and run them in parallel as native subagent ensembles.

When a subagent call targets a model pack, the plugin creates a native coordinator session that dispatches the task to every configured model in the pack concurrently, collects their independent responses, and returns either a deterministic multi-model report or an optional synthesized consensus answer.

---

## Introduction

### Key Features

- **Parallel Multi-Model Ensembles**: Expand a single subagent task across multiple models and providers (including duplicate model entries and per-member reasoning effort variants) bounded by configurable concurrency and worker limits.
- **Zero-Token Static Coordinator**: A local scripted AI SDK adapter drives the coordinator session without making external LLM calls or consuming tokens for dispatch.
- **Native OpenCode Session Hierarchy**: Every pack run creates real, inspectable OpenCode child sessions. Click the coordinator subagent call to inspect individual worker subagent calls and open their full transcripts—no custom TUI required.
- **Optional Consensus Synthesis**: Choose between deterministic labelled reports (zero extra LLM calls) or a single tool-free synthesis pass that merges worker findings while preserving disagreements and uncertainty.
- **Multi-Turn Follow-Ups & Background Execution**: Reuse the coordinator `sessionID` to send follow-up prompts to the entire pack while preserving each worker's conversation history, or run packs asynchronously in the background.
- **Reasoning Effort Support**: Uses native model effort variants (`provider/model#high`) when available, or supplies `reasoningEffort` via a worker-scoped context hook.

### How It Works

```text
Parent conversation
└── Pack coordinator (local scripted adapter, 0 tokens)
    ├── Native subagent call → Worker 1 (e.g. claude-fable-5-1#high)
    ├── Native subagent call → Worker 2 (e.g. gpt-6.1-sol#max)
    ├── Native subagent call → Worker 3 (e.g. gemini-4-argon)
    └── Final assistant answer (deterministic report or consensus synthesis) → returned to parent
```

### Current Limitations

- **Subagent Target Only**: Packs are designed for `subagent` calls (or agents running in `subagent` mode), not primary top-level chat models.
- **Shared Workspace**: Parallel workers run in the same workspace. Prefer read-only subagent permissions (denying `edit`, `write`, `shell`, and nested `subagent`) until isolated worktrees are implemented.
- **Inter-Agent Messaging**: `enableInterAgentMessaging` is reserved for a future phase; setting it to `true` logs a warning and runs workers independently.

For deeper architectural details, see [Current Implementation](docs/CURRENT_STATE.md), [Architecture](docs/ARCHITECTURE.md), and [Constants Reference](docs/CONSTANTS.md).

---

## Setup

### Prerequisites

- [Bun](https://bun.sh/) v1.2+
- OpenCode V2 (`@opencode/plugin` `2.2.0`)

### 1. Install and Build

Clone the repository, install dependencies, and bundle the plugin:

```sh
bun install
bun run build
```

`bun run build` bundles the plugin into `dist/index.ts` and `dist/server.ts`.

### 2. Configure `opencode.jsonc`

Register the plugin and define your model packs in your project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./dist",
      "options": {
        "packProviderId": "packs",
        "maxConcurrency": 2,
        "timeoutMs": 120000,
        "maxWorkersPerRun": 16,
        "consensus": {
          "enabled": false,
          "model": null,
          "timeoutMs": 120000,
          "maxInputToken": "25%",
          "maxResultToken": "25%"
        },
        "packs": {
          "review": {
            "maxConcurrency": 3,
            "consensus": {
              "enabled": true,
              "model": "anthropic/claude-sonnet-4-5"
            },
            "models": [
              "anthropic/claude-opus-4-5#high",
              "openai/gpt-5#high",
              {
                "provider": "google",
                "model": "gemini-2.5-pro",
                "effort": "high"
              }
            ]
          },
          "fast-check": {
            "models": [
              "openai/gpt-5-mini",
              "anthropic/claude-haiku-4-5"
            ]
          }
        }
      }
    }
  ]
}
```

### Configuration Options Reference

| Option | Scope | Default | Description |
| --- | --- | --- | --- |
| `packProviderId` | Global (required) | — | Virtual provider ID prefix used to select packs (`<packProviderId>/<packId>`). |
| `packs` | Global (required) | — | Map of pack IDs to their configuration and `models` array. |
| `packs.<id>.models` | Per-pack (required) | — | Ordered list of `"provider/model"` or `"provider/model#effort"` strings, or `{ provider, model, effort? }` objects. |
| `maxConcurrency` | Global / Per-pack | `2` | Maximum number of workers allowed to execute simultaneously. |
| `timeoutMs` | Global / Per-pack | `120000` | Timeout in milliseconds for each individual worker execution. |
| `maxWorkersPerRun` | Global | `16` | Maximum number of resolved, available workers per run (duplicate entries count independently). |
| `consensus.enabled` | Global / Per-pack | `false` | When `true`, runs a single tool-free synthesis call over all successful worker responses. |
| `consensus.model` | Global / Per-pack | `null` | Model used for synthesis. When `null`, falls back to the parent session's active model, agent model, or workspace default. |
| `consensus.timeoutMs` | Global / Per-pack | `120000` | Timeout in milliseconds for the consensus synthesis request. |
| `consensus.maxInputToken` | Global / Per-pack | `"25%"` | Positive integer evidence-token cap, or percentage string of the consensus model's input allowance; always bounded by space after instructions. |
| `consensus.maxResultToken` | Global / Per-pack | `"25%"` | Positive integer parent-result token cap, or percentage string of the parent's remaining usable capacity. |
| `enableInterAgentMessaging` | Per-pack | `false` | Reserved for future inter-agent messaging support. |

> **Note:** Model matching against enabled catalog models is exact and case-sensitive. Unavailable models are skipped with a warning rather than failing the entire pack (unless no models in the pack are available). Virtual pack models cannot reference other packs.

Budgeting needs only the two dual settings above; both default to `"25%"`.
Use a number for absolute tokens (`15000`), or a string ending in `%` for relative
tokens (`"25%"`, `"12.5%"`). Percentages must be greater than zero and at most 100;
absolute values must be positive integers. Both modes are clamped to available capacity. Instructions,
wrappers, the estimator safety margin and parent continuation space are reserved
automatically. The continuation reserve is 5% of the parent's safe input allowance,
up to 4,096 tokens. No default absolute token or character ceilings override the
percentages. Result budgeting also applies when consensus is disabled or fails.

**Migration:** `maxInputPercentage`, `maxResultPercentage`, `maxInputTokens`,
`maxResultTokens`, `parentReserveTokens`, and `maxInputChars` remain deprecated
compatibility settings and emit startup warnings. New singular names take precedence
within a scope; per-pack settings override global settings. Where both old percentage
and token aliases are supplied, the percentage alias determines the normalized limit.

Worker requests are estimated from the complete outbound context (system parts,
conversation history, tool definitions, and protocol overhead) with
[`ai-tokenizer`](https://www.npmjs.com/package/ai-tokenizer). Requests exceeding
85% of a catalog model's declared input limit are rejected before provider
submission. The margin accounts for tokenizer approximation and provider-added
metadata; estimates are not provider billing totals.

Estimator diagnostics distinguish `known-profile` (matching packaged model ID),
`family-approximation` (a representative profile for a different version), and
`unknown-fallback` (no supported mapping). None guarantees provider acceptance.
Unknown mappings produce visible pack warnings and server logs; their GPT-5
fallback remains a heuristic for limiting, not a validated context-fit check.
Gemma and Nemotron are explicitly identified as unsupported families rather than
being described as GPT-compatible. Matching profiles can also have substantial
estimation error; multimodal inputs are not measured precisely.

### 3. Optional: Configure Dedicated Subagents

You can bind a subagent directly to a model pack by creating an agent markdown file in `.opencode/agents/` (for example, `.opencode/agents/ensemble-worker.md`):

```markdown
---
description: Independent focused assessment, expanded across the configured model pack
mode: subagent
model: packs/review
permissions:
  - action: subagent
    resource: "*"
    effect: deny
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
---

You are one independent worker in a multi-model ensemble.
Produce a clear, self-contained response with conclusions, key supporting evidence, assumptions, and uncertainty.
```

---

## Usage

### Running a Pack via Subagent

You can invoke a model pack in two ways during an OpenCode session:

1. **Using a pack-configured subagent** (like `ensemble-worker` above):
   Ask OpenCode to delegate a task to the `ensemble-worker` subagent. Because its default `model` is set to `packs/review`, it automatically expands across the pack.
2. **Specifying the pack model explicitly on any subagent call**:
   Pass `model: "<packProviderId>/<packId>"` (e.g., `packs/review`) when invoking the `subagent` tool with an existing agent such as `explore` or `general`.

### Foreground and Background Execution

- **Foreground (`background: false`)**: Waits for all workers (and optional consensus synthesis) to finish, returning the final answer and the coordinator `sessionID` directly to the parent conversation.
- **Background (`background: true`)**: Immediately returns an acknowledgement with the coordinator `sessionID` and any skipped-member warnings, then notifies the parent session when the pack finishes.

### Multi-Turn Follow-Ups

To ask follow-up questions to the ensemble, pass the **coordinator `sessionID`** returned from the initial subagent call back to the `subagent` tool:

- Every worker in the pack receives the follow-up in its own existing child session, retaining its prior context.
- Do not pass an individual worker's session ID to the parent `subagent` tool; always use the top-level coordinator `sessionID`.

### Inspecting Worker Transcripts

1. In the OpenCode UI/TUI, click the native subagent call in your parent conversation to open the **Pack Coordinator** session.
2. Inside the coordinator session, you will see one native `subagent` tool call per worker model.
3. Click any worker tool call to inspect that specific model's full reasoning and response transcript.
4. The coordinator's final assistant message contains the complete output returned to the parent session.

---

## Contributing

Contributions, bug reports, and feature enhancements are welcome!

### Development Workflow

1. Fork the repository and create a feature branch.
2. Install dependencies:
   ```sh
   bun install
   ```
3. Make your changes in `src/` and add or update tests in `test/`.
4. Run the full verification suite before opening a pull request:
   ```sh
   bun run check
   ```

### Verification Scripts

| Command | Description |
| --- | --- |
| `bun run check` | Runs all checks below (`lint`, `syntax`, `typecheck`, `build`, `test`, and `check:effect`). |
| `bun test` | Runs the integration test suite with an in-memory OpenCode host context. |
| `bun run build` | Bundles `src/` into `dist/index.ts` and `dist/server.ts`. |
| `bun run lint` | Checks formatting and lint rules with Biome (`bun run lint:fix` to auto-format). |
| `bun run typecheck` | Runs TypeScript type checking (`tsc --noEmit`). |
| `bun run syntax` | Verifies bundle syntax and entrypoint constraints. |
| `bun run check:effect` | Runs Effect-specific static checks. |

### Codebase Guidelines

- Keep plugin-wide defaults, identities, prompts, and storage prefixes in [`src/constants.ts`](src/constants.ts) and keep [`docs/CONSTANTS.md`](docs/CONSTANTS.md) in sync when defaults change.
- Follow existing Effect v4 patterns and Biome formatting rules (tabs for indentation, double quotes).
- Ensure new behavior is covered by tests in `test/`.

---

## Versioning

This project adheres to [Semantic Versioning (SemVer 2.0.0)](https://semver.org/):

- **MAJOR** (`X.0.0`): Incompatible API, configuration schema, or persistence contract changes.
- **MINOR** (`0.X.0`): Backwards-compatible new features and options.
- **PATCH** (`0.0.X`): Backwards-compatible bug fixes and internal improvements.

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
