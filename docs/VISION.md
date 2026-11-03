# Vision: OpenCode Pack Models (`opencode-pack-models`)

## 1. Executive Summary
`opencode-pack-models` extends OpenCode V2 with **Model Packs**: configurable ensembles of models registered under a dedicated virtual provider (`packProviderId`). Anywhere a model can be referenced in OpenCode (`providerId/modelId`), a user or agent can specify a Pack Model (e.g., `customProviderId/free` or `customProviderId/big-five`).

Instead of executing a prompt in a single model session, a Pack Model fans out the task in parallel across all configured member models in the pack, managing concurrency, timeouts, multi-turn follow-ups, optional inter-agent communication, and optional consensus synthesis—all using native OpenCode V2 capabilities.

---

## 2. Core Principles
1. **Native OpenCode Look & Feel**:
   - Packs are registered as first-class models under the configured `packProviderId` via OpenCode's `ctx.provider.transform` API.
   - Each pack run creates a real **Coordinator Session** (`resume: false`, zero LLM cost) plus **$N$ native Worker Sessions** (`ctx.session`), preserving OpenCode's native streaming, tool execution, permissions, token/cost tracking, and TUI inspectability without requiring a custom TUI plugin in Phases 1 & 2.
   - Built strictly on `@opencode/plugin/effect` (Effect-TS API) for structured concurrency, semaphores, timeouts, and schema validation.
2. **Token Efficiency & Scalability**:
   - When `consensus.enabled: false`, all individual worker responses are returned directly to the caller like normal subagent outputs.
   - When `consensus.enabled: true`, a stateless synthesis call (`ctx.experimental.generate.text`) condenses the worker outputs (using fair per-worker character budgeting) and returns **only** the synthesized summary to the parent session—preventing context window bloat when running many models or large analyses.
   - If the consensus synthesis call fails or times out, the plugin gracefully falls back to returning the individual worker responses with a warning header so the work of the $N$ models is never lost.
3. **Zero-LLM Routing Overhead**:
   - Session mapping (`PackGroupManager`), follow-up prompt broadcasting, concurrency control, and inter-agent message routing are deterministic and handled in-process without extra LLM calls.
4. **Resilience by Default**:
   - Missing or unavailable models in a pack configuration (strictly case-sensitive exact ID matching) are skipped with a warning rather than crashing setup.
   - Partial execution failures (e.g., one model timing out or hitting rate limits) still succeed as long as at least one worker model completes, clearly reporting both successes and failures.

---

## 3. Phased Delivery Roadmap

### Phase 1: Pack Models for Subagents (No Inter-Agent Chat)
- Mandatory `packProviderId` configuration validation and virtual provider/model registration.
- Strict case-sensitive exact model ID resolution (supporting literal characters like `*` in model IDs, excluding `/` and `#` delimiters), duplicate entries as independent workers, and both string (`provider/model#effort`) and object (`{ provider, model, effort }`) syntax.
- Smart effort/variant resolution: uses native OpenCode model `variant` if present on the target model, or falls back to passing `reasoningEffort` via `ctx.session.hook("context")`.
- Interception of `subagent` tool calls (both foreground `background: false` and background `background: true`) when the target agent or explicit `model` parameter points to `<packProviderId>/<packName>`.
- Parallel execution across $N$ worker child sessions bounded by `maxConcurrency`, `maxWorkersPerRun`, and `timeoutMs`.
- Real Coordinator Session + `ctx.storage` mapping abstracted behind `PackGroupManager` so follow-up `subagent` calls broadcast to all $N$ worker sessions without LLM overhead.
- Output modes:
  - `consensus.enabled: false`: Return all worker results directly.
  - `consensus.enabled: true`: Return only the synthesized consensus result (with automatic fallback to individual outputs if synthesis fails).

### Phase 2: Asynchronous Inter-Agent Communication (`enableInterAgentMessaging: true`)
- Free-form, non-turn-based communication between parallel worker sessions within a pack run (no barrier synchronization; workers complete independently).
- Workers are identified by `worker-<index> (<provider>/<model>)` and receive `<context key="pack-messaging">` instructions plus `pack_post_message` (supporting broadcast or targeted `to` direct messages) and `pack_read_board` tools.
- Posting a message updates `<context key="pack-peer-messages">` on target sibling sessions via `ctx.session.instructions.entry.put` (delivered at their next step boundary without interrupting active tool calls) and appends to the Coordinator Session's audit log.

### Phase 3: Pack Models for Primary Agents (Deferred to Dedicated PoC & UX Evaluation)
- Phase 3 will be evaluated in a separate planning/PoC session to prototype different orchestration and TUI UX strategies.
- When workspace mutations (file edits/shell commands) occur across parallel workers, isolated Git worktrees per worker (using OpenCode's native `ctx.worktree` API) are the target direction to prevent concurrent file overwrites.
