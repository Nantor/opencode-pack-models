# Decision Log: OpenCode Pack Models (`opencode-pack-models`)

## Round 1 Decisions (Settled)

- **D1 (Documentation Structure)**: Maintain dedicated documents in `docs/`:
  - `VISION.md`
  - `ARCHITECTURE.md`
  - `IMPLEMENTATION_PLAN.md`
  - `DECISIONS.md`
  Use the interactive `question` tool for all design rounds.
- **D2 (Virtual Provider & Model Matching)**:
  - `packProviderId` is **required** (not optional).
  - Model IDs are matched **exactly** (no wildcard globbing; model IDs may literally contain `*` and arbitrary characters other than `/` and `#`).
  - Missing/unavailable models in a pack are skipped with a warning.
  - Both string (`"provider/model#effort"`) and object (`{ provider, model, effort }`) syntaxes are supported.
- **D3 (Phase 1 Subagent Interception)**:
  - Option A selected: Intercept `subagent` tool calls targeting a pack model, spawn $N$ native worker child sessions bounded by `maxConcurrency` and `timeoutMs`, and return the result to the parent session.
- **D4 (Output & Consensus Behavior)**:
  - When `consensus.enabled: false`: Each worker subagent result is returned directly to the parent agent like normal subagents.
  - When `consensus.enabled: true`: Only the synthesized summary from `consensus.model` is returned to the parent agent (omitting raw worker outputs to protect parent context token usage when many agents or large outputs are involved).
- **D5 (Multi-Turn Follow-up `sessionID`)**:
  - Deterministic mapping in `ctx.storage` from a Pack Group `sessionID` to each child worker's `sessionID` (zero LLM overhead). Follow-up calls to that `sessionID` broadcast the new prompt to each worker session.
- **D6 (Partial Failure Handling)**:
  - A pack run succeeds as long as at least 1 worker model succeeds; failed or timed-out workers are noted alongside successful results.
- **D7 (Phase 2 & Phase 3 Direction)**:
  - Phase 2: Free-form (no fixed rounds/turns) communication tool/mechanism allowing workers to post directly into peer chats or a shared message board.
  - Phase 3: Open for architectural and UX exploration.

## Round 2 Decisions (Settled)

- **D8 (Model ID Case Sensitivity)**:
  - Model ID matching is **strictly case-sensitive**. If a model ID in config does not match the exact casing in `ctx.model.list()`, it is omitted with a warning.
- **D9 (Consensus Model Resolution & Fallback)**:
  - `consensus` config can be defined globally and overridden per pack.
  - If `consensus.enabled` is `true`, resolve `consensus.model` from: (1) per-pack `consensus.model`, (2) global `consensus.model`, (3) fallback to the **parent session's active model**.
- **D10 (Phase 2 Inter-Agent Communication Mechanism)**:
  - Use **Shared Board + Auto Context Injection**: Workers in packs with `enableInterAgentMessaging: true` get `pack_post_message` and `pack_read_board` tools, and new posts are automatically pushed to sibling workers via `ctx.session.instructions.entry.put` (`<context key="pack-peer-messages">`), arriving at their next step boundary without interrupting active tool calls.
- **D11 (Phase 3 Scope & Isolation)**:
  - Defer Phase 3 UX and orchestration design to a separate dedicated planning/PoC session.
  - Record **Isolated Worktree per Worker** (`ctx.worktree`) as the chosen strategy for handling workspace mutations when parallel workers have edit/shell permissions.

## Round 3 Decisions (Settled)

- **D12 (Background Subagent Support)**:
  - Support both `background: false` (foreground, waits and returns result) and `background: true` (background fiber, returns `groupSessionID` immediately and notifies parent via `ctx.session.synthetic` upon completion).
- **D13 (Duplicate Models in Pack)**:
  - Allow duplicate model entries in a pack's `models` array; each entry spawns a separate independent worker session (`worker-1`, `worker-2`, etc.).
- **D14 (Phase 2 Peer Identity & Addressing)**:
  - Identify workers by `worker-<index> (<provider>/<model>)` and support both broadcast and optional `to` direct messaging in `pack_post_message`.
- **D15 (Phase 2 Completion Semantics)**:
  - Independent completion with no barrier: each worker finishes as soon as its response is ready without forced extra waiting rounds.
- **D16 (Plugin Runtime API)**:
  - Build the server plugin using OpenCode V2's Effect-native API (`@opencode/plugin/effect`) with `effect` for structured concurrency, semaphores, timeouts, and schema validation.

## Round 4 & 5 Decisions (Settled)

- **D17 (Coordinator Session Strategy)**:
  - Use **Option 2: Real Coordinator Session** (`ctx.session.create` with `resume: false` via `ctx.session.synthetic` so it incurs zero LLM cost), abstracted behind `PackGroupManager` so the strategy can be changed in ~20 lines if ever needed.
- **D18 (Consensus Synthesis Failure Fallback)**:
  - If `consensus.enabled` is `true` and the synthesis call fails or times out after workers have succeeded, gracefully fall back to returning the individual worker responses with a warning header so worker outputs are never lost.
- **D19 (Server-Only Scope for Phase 1 & 2)**:
  - Keep Phase 1 and Phase 2 server-only (relying on OpenCode's native child sessions, Coordinator session transcript, and tool progress UI). Defer custom `./tui` plugin components to Phase 3.
- **D20 (Effort / Variant Application)**:
  - Check if the target model in `ctx.model.list()` defines a matching native `variant` first; if not, pass `effort` via `ctx.session.hook("context")` (`event.options.reasoningEffort = effort`).
- **D21 (Consensus Execution Method)**:
  - Use stateless `ctx.experimental.generate.text` for the consensus synthesis call and record the output in the Coordinator session via `ctx.session.synthetic(..., { resume: false })`.
- **D22 (Fair Per-Worker Truncation for Consensus)**:
  - Divide the `consensus.maxInputToken` evidence budget fairly across workers. The two public budget controls accept positive integer token counts or percentage strings; defaults are `"25%"`. Legacy aliases are normalized with startup warnings.
- **D23 (Worker System Instructions)**:
  - Leave worker system prompts 100% untouched in Phase 1; in Phase 2 (`enableInterAgentMessaging: true`), inject only a `<context key="pack-messaging">` instruction entry explaining the peer roster and messaging tools.
