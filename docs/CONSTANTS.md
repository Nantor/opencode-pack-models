# Shared constants

[`src/constants.ts`](../src/constants.ts) is the dependency-free source of truth for plugin-wide defaults, identities, prompts, and persistence prefixes. Constants are module exports, not mutable process globals. Each export has an inline description.

## Configuration defaults

These values apply only when the corresponding option is omitted. Per-pack settings override global settings; global settings override these defaults. `maxWorkersPerRun` is global-only, and `enableInterAgentMessaging` is pack-only.

| Constant | Default | Meaning |
| --- | --- | --- |
| `DEFAULT_MAX_CONCURRENCY` | `2` | Maximum simultaneously executing workers in a pack. |
| `DEFAULT_WORKER_TIMEOUT_MS` | `120000` ms | Deadline for one worker's switch/prompt/wait/context operation. |
| `DEFAULT_MAX_WORKERS_PER_RUN` | `16` | Cap on resolved, available workers; duplicate members count independently. |
| `DEFAULT_INTER_AGENT_MESSAGING_ENABLED` | `false` | Workers run independently. Messaging remains unimplemented even if enabled. |
| `DEFAULT_CONSENSUS.enabled` | `false` | Opt in to a single tool-free synthesis request. |
| `DEFAULT_CONSENSUS.model` | `null` | Resolve the parent's model, its agent model, then the workspace default at runtime. |
| `DEFAULT_CONSENSUS.timeoutMs` | `120000` ms | Deadline for the synthesis request. Independent of the worker timeout. |
| `DEFAULT_CONSENSUS.maxInputTokens` | `null` | Deprecated absolute evidence override; disabled unless explicitly supplied. |
| `DEFAULT_CONSENSUS.maxInputToken` | `"25%"` | Evidence cap: positive integer tokens or percentage string of consensus input allowance. |
| `DEFAULT_CONSENSUS.maxResultToken` | `"25%"` | Parent-result cap: positive integer tokens or percentage string of remaining usable parent capacity. |
| `DEFAULT_CONSENSUS.maxInputPercentage` / `maxResultPercentage` | `25` | Deprecated numeric percentage aliases; only explicit values participate in normalization. |
| `DEFAULT_CONSENSUS.maxResultTokens` | `null` | Deprecated absolute result override; disabled unless explicitly supplied. |
| `DEFAULT_CONSENSUS.parentReserveTokens` | `null` | Automatic continuation reserve: 5% of safe parent capacity, capped at 4096 tokens. Explicit legacy overrides remain honored. |
| `DEFAULT_CONSENSUS.maxInputChars` | `null` | Deprecated character ceiling; disabled unless explicitly supplied. |

`DEFAULT_CONSENSUS` is frozen and copied during decoding. Overrides must never mutate shared defaults. An explicit per-pack `consensus.model: null` clears a globally configured model.

## Identities and internal contracts

| Constant | Value / purpose |
| --- | --- |
| `PLUGIN_ID` | `opencode-pack-models`; plugin registration and Effect service namespace. |
| `PACK_PROVIDER_NAME` | `Model Packs`; virtual provider display name. |
| `COORDINATOR_ID_SUFFIX` | `-coordinator`; appended to the configured `packProviderId` for both the hidden agent and local provider. |
| `COORDINATOR_MODEL_ID` | `static`; local coordinator model registration and selection. |
| `COORDINATOR_AGENT_NAME` | `Pack coordinator`; hidden agent display name. |
| `COORDINATOR_PROVIDER_NAME` | `Static pack coordinator`; local provider/model display name. |
| `SCRIPTED_PROVIDER_ID` | `opencode-pack-scripted`; adapter identity and `aisdk:` package suffix. |
| `COORDINATOR_SESSION_MARKER` | `pack-coordinator:`; connects the system message emitted by the context hook to the adapter's active-turn lookup. |
| `COORDINATOR_SYSTEM_PROMPT` | Instructions shared by the hidden agent and context hook; dispatch is static, without autonomous planning or tool selection. |
| `CONSENSUS_SYSTEM_PROMPT` | Tool-free synthesis instructions; treat worker evidence as data and preserve uncertainty and disagreements. |
| `SUBAGENT_TOOL_NAME` | `subagent`; shared by tool interception, coordinator dispatch, context filtering, and permission checks. |
| `GROUP_STORAGE_PREFIX` | `pack_group/`; coordinator membership records. |
| `WORKER_STORAGE_PREFIX` | `pack_worker/`; worker-to-coordinator reverse indexes. |
| `NATIVE_SESSION_ID_PREFIX` | `ses`; matches the host's native session-ID contract. |
| `TRUNCATION_MARKER` | `[...truncated]`; counted within the evidence budget and itself shortened for very small quotas. |

Storage prefixes are persistence contracts: changing them requires migration or backward-compatible reads for existing groups. Native session and tool identifiers must match the host, not be renamed as preferences. Coordinator identities and marker producers/consumers must remain aligned. Review prompt changes as behavior changes, not just wording changes.

## What belongs here

Add a constant when it defines a shared contract, a configurable default, or a meaningful plugin-wide policy. Keep generic host protocol literals (such as message types and finish reasons), schema definitions, one-off error text, algorithmic `0`/`1` values, and per-instance mutable state close to their consumers. Build-script settings remain in the scripts rather than coupling build tooling to runtime constants.

Tests may intentionally assert literal values to catch unintended changes to documented defaults and persistent contracts. Changing a default should update this reference and the relevant tests together.
