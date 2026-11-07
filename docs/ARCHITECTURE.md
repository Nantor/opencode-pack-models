# Architecture: OpenCode Pack Models (`opencode-pack-models`)

## 1. High-Level System Overview

The plugin is built on OpenCode V2's **Effect-native Plugin API (`@opencode/plugin/effect`)** for structured concurrency (`Effect.Semaphore`, `Effect.timeout`, `Scope`-bound fiber interruption, and `Schema` validation). Phases 1 & 2 are **server-only** (`src/index.ts`), relying on OpenCode's native session hierarchy and tool progress UI.

```text
+-------------------------------------------------------------------+
|                        Parent Session / User                      |
+-------------------------------------------------------------------+
                                  |
                  subagent(agent="thinking-hard", background?)
                  model = "customProviderId/big-five"
                                  v
+-------------------------------------------------------------------+
|                Pack Orchestrator (Effect Server Plugin)           |
|  - Resolves Pack Definition ("big-five")                          |
|  - Validates exact case-sensitive models via ctx.model.list()     |
|  - Enforces maxWorkersPerRun, maxConcurrency, timeoutMs           |
|  - PackGroupManager: Coordinator Session <-> [Worker 1..N]        |
+-------------------------------------------------------------------+
       |                  |                  |                  |
       v                  v                  v                  v
+-------------+    +-------------+    +-------------+    +-------------+
| Worker 1    |    | Worker 2    |    | Worker 3    |    | Worker N    |
| Claude 5.1* |<-->| GPT-6.1 Sol |<-->| DeepSeek V4 |<-->| Gemini 4    |
| (#high)     |    | (#max)      |    |             |    | Argon       |
+-------------+    +-------------+    +-------------+    +-------------+
       \                  \                  /                  /
        \                  \                /                  /
         +------------------+--------------+------------------+
                                   |
                        consensus.enabled?
                         /              \
                      false             true
                       /                  \
                      v                    v
        +------------------------+   +-------------------------+
        | Direct Multi-Subagent  |   | Consensus Synthesizer   |
        | Result Aggregation     |   | (generate.text)         |
        | (All worker outputs)   |   | Returns ONLY summary    |
        +------------------------+   | (Fallback to direct on  |
                                     |  synthesis error)       |
                                     +-------------------------+
```

---

## 2. Configuration & Model Resolution

### 2.1 Configuration Schema
Validated at plugin startup using `effect/Schema`:
- `packProviderId` (**Required**, non-empty string, no `/` or `#`): The virtual provider ID registered in OpenCode.
- `maxConcurrency` (number, default `2`): Default max concurrent worker sessions per pack run.
- `timeoutMs` (number, default `120000`): Default per-worker timeout in ms.
- `maxWorkersPerRun` (number, default `16`): Hard cap on workers spawned in a single pack invocation.
- `consensus`:
  - `enabled` (boolean, default `false`)
  - `model` (string | object | null, default `null`): Model used for synthesis when `enabled: true`.
  - `systemPrompt` (non-blank string | null, default `CONSENSUS_SYSTEM_PROMPT`): Custom synthesis instructions replacing `CONSENSUS_SYSTEM_PROMPT` (`null` resets to default).
  - `timeoutMs` (number, default `120000`)
  - `maxInputToken` (positive integer | percentage string, default `"25%"`): Consensus evidence token cap or input-capacity share.
  - `maxResultToken` (positive integer | percentage string, default `"25%"`): Parent result token cap or remaining-capacity share.
  - Deprecated explicit overrides: `maxInputTokens`, `maxResultTokens`, `parentReserveTokens`, `maxInputChars`. None applies by default; supplied values remain honored with a startup warning.
- `packs`: Record of `<packName>` to Pack Definition:
  - `maxConcurrency` (optional number override)
  - `timeoutMs` (optional number override)
  - `enableInterAgentMessaging` (boolean, default `false`)
  - `consensus` (optional partial override of global `consensus` settings)
  - `models`: Array of member model entries:
    - String format: `"<providerId>/<modelId>"` or `"<providerId>/<modelId>#<effort>"`
    - Object format: `{ "provider": "<providerId>", "model": "<modelId>", "effort"?: "<effort>" }`

### 2.2 Exact Model Matching & Effort Rules
1. **Parsing**:
   - In string format, split on the **first** `/` to separate `providerId` and the remainder, and split on the **last** `#` (if present) to separate `modelId` and `effort`.
   - `modelId` may contain `*` or any other literal characters (e.g., `claude-fable-5-1*` is an **exact** model ID, not a glob pattern).
2. **Lookup**:
   - Matching against `ctx.model.list()` is **strictly case-sensitive** (`model.providerID === providerId && model.id === modelId`).
   - If a configured model is not found or disabled, it is **omitted with a warning** (`Effect.logWarning`) rather than failing the pack.
3. **Duplicates**:
   - Duplicate entries in `models` are preserved and spawn separate independent worker sessions (`worker-1`, `worker-2`, ...), capped at `maxWorkersPerRun`.
4. **Effort / Variant Application**:
   - If `effort` is specified:
     - First check if the resolved `Model.Info` in `ctx.model.list()` defines a matching native variant in `model.variants`. If so, pass `variant: effort` to `ctx.session.switchModel`.
     - Otherwise, record `effort` on the worker state and apply `event.options.reasoningEffort = effort` in `ctx.session.hook("context")` for that worker's `sessionID`.

### 2.3 Token Limits, Consensus Model Resolution & Fair Truncation
1. **Model Hierarchy**:
   - Pack-level `packs[packName].consensus.model`
   - Global `options.consensus.model`
   - Fallback: The **parent session's active model** (`parentSession.model`).
2. **Worker Request Preflight**:
   - Estimate complete worker requests with `ai-tokenizer`, including system content, history, tool definitions and structural overhead.
   - Reject requests above 85% of the catalog model's `limit.input` (or `limit.context - limit.output`) to allow for estimator and provider overhead.
3. **Fair Per-Worker Input Budgeting (`maxInputToken`)**:
   - Apply legacy ceilings only when explicitly configured.
   - Reserve fixed synthesis prompt overhead from 85% of the model input limit, then cap evidence by `maxInputToken`: an absolute count or a percentage of the declared input allowance.
   - Sort worker outputs by estimated tokens ascending. Each remaining worker gets an equal share of the remaining token budget.
   - Workers shorter than their quota use only their actual length and donate their unused budget to longer worker responses. Workers exceeding their fair share are truncated cleanly with a `[...truncated]` marker.
4. **Stateless Execution & Fallback**:
   - Execute synthesis via `ctx.experimental.generate.text({ model, prompt })` bounded by `consensus.timeoutMs`.
   - Log the synthesized result into the Coordinator Session via `ctx.session.synthetic({ sessionID: coordinatorID, text, resume: false })`.
   - If synthesis fails or times out, log a warning and return the direct multi-worker output with a warning banner so no worker results are lost.

---

## 3. Session Mapping & `PackGroupManager` (Zero-LLM)

To keep session representation modular and easily swappable in the future, all group session operations go through `PackGroupManager`:

```ts
export interface PackWorkerRecord {
  readonly workerId: string // e.g., "worker-1"
  readonly label: string    // e.g., "worker-1 (adesso-ai-hub/claude-fable-5-1*)"
  readonly providerID: string
  readonly modelID: string
  readonly effort?: string
  readonly useHookEffort: boolean
  readonly sessionID: string
  status: "running" | "succeeded" | "failed" | "timed_out"
}

export interface PackGroupRecord {
  readonly groupSessionID: string // Real Coordinator Session ID
  readonly packId: string
  readonly agentId: string
  readonly parentSessionID: string
  readonly enableInterAgentMessaging: boolean
  readonly workers: PackWorkerRecord[]
  readonly createdAt: number
}
```

### 3.1 Coordinator Session Lifecycle
- **Creation**: When a new pack subagent call starts (no existing `sessionID`), `PackGroupManager.createGroup` creates a real OpenCode session (`ctx.session.create({ title: "[Pack: <packId>] <description>" })`). Its `id` is `groupSessionID`.
- **Audit Trail**: All prompts, worker completion summaries, Phase 2 peer messages, and consensus syntheses are appended to the Coordinator Session via `ctx.session.synthetic({ sessionID: groupSessionID, text, resume: false })` (zero LLM tokens spent in Coordinator).
- **Multi-Turn Follow-ups**: When the parent agent passes `sessionID: groupSessionID` to `subagent`, `PackGroupManager.getGroup(groupSessionID)` retrieves the record from memory/`ctx.storage` in O(1) time and dispatches the follow-up prompt in parallel to each worker's `sessionID`.
- **Foreground vs. Background**:
  - `background: false` (default): Waits for the worker pool fiber to finish and returns the final formatted text + `sessionID: groupSessionID`.
  - `background: true`: Forks the worker pool into the plugin scope (`Effect.forkScoped`), returns `sessionID: groupSessionID` immediately to the parent, and when the background fiber finishes, posts the final result to `parentSessionID` via `ctx.session.synthetic`.

---

## 4. Phase 2 Architecture: Inter-Agent Communication

When `enableInterAgentMessaging: true` on a pack:
1. **Phase 1 Parity**: When `enableInterAgentMessaging: false`, worker system prompts and tools are 100% untouched.
2. **Context Entry & Scoped Tools**:
   - On creation of each worker session in an inter-agent-enabled pack, the plugin writes `<context key="pack-messaging">` via `ctx.session.instructions.entry.put`, informing the worker of its own `workerId`, the roster of peer workers (`worker-1 (model)`, `worker-2 (model)`, ...), and how to use `pack_post_message` and `pack_read_board`.
   - Via `ctx.session.hook("context")`, `pack_post_message` and `pack_read_board` are kept in `event.tools` **only** for sessions registered as active Phase 2 pack workers, and stripped (`delete event.tools.pack_post_message`, `delete event.tools.pack_read_board`) from all other sessions.
3. **Message Routing & Live Auto-Injection**:
   - `pack_post_message({ message: string, to?: string })`:
     - Appends the message entry `{ id, from: worker.label, to: to ?? "all", message, timestamp }` to the group's shared board (and logs it to the Coordinator Session via `ctx.session.synthetic(..., { resume: false })`).
     - Determines recipient workers (all siblings if `to` is omitted/broadcast, or the specific sibling matching `to`).
     - For each recipient worker session, calls `ctx.session.instructions.entry.put({ sessionID: recipient.sessionID, key: "pack-peer-messages", value: formattedMessagesForRecipient })`.
     - OpenCode automatically injects the updated `<context key="pack-peer-messages">` block at the recipient's next step boundary without interrupting its current tool execution.
   - `pack_read_board()`:
     - Returns all broadcast messages and direct messages addressed to/from the calling worker.
4. **Independent Completion (No Barrier)**:
   - Workers finish naturally as soon as they produce their final answer; no worker is artificially held back or forced into extra turns.

---

## 5. Phase 3 Architecture: Primary Agent Pack Execution (Deferred)
- Detailed primary-agent UX and orchestration architecture will be explored in a dedicated future session via PoCs.
- For agents with workspace mutation permissions (`edit`, `shell`), isolated Git worktrees per worker (`ctx.worktree`) are the chosen isolation mechanism.
