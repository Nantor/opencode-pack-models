# Implementation Plan: OpenCode Pack Models (`opencode-pack-models`)

## Overview of Phases

| Phase | Scope | Key Deliverables |
| :--- | :--- | :--- |
| **Phase 1** | Subagents Only (No Inter-Agent Chat) | Effect plugin scaffold (`src/index.ts`), Config Schema validator, Virtual Provider (`packProviderId`), Strict Case-Sensitive Model & Effort Resolver, `PackGroupManager` (Coordinator Session + Storage), `subagent` Tool Override (Foreground & Background), Parallel Worker Runner (`Effect.Semaphore`, `Effect.timeout`), Direct vs. Consensus Synthesizer (with fair truncation & fallback). |
| **Phase 2** | Inter-Agent Messaging (`enableInterAgentMessaging`) | In-memory/storage Pack Message Board, `pack_post_message` (broadcast + DM) and `pack_read_board` tools, `ctx.session.hook("context")` tool scoping, live peer context injection via `ctx.session.instructions.entry.put`. |
| **Phase 3** | Primary Agents Support (Separate Session) | Deferred to a dedicated PoC & UX evaluation session; uses per-worker isolated Git worktrees (`ctx.worktree`) for workspace mutations. |

---

## Proposed File Structure (Phase 1 & Phase 2)

```text
opencode-pack-models/
├── package.json
├── tsconfig.json
├── opencode.jsonc
├── .opencode/
│   └── agents/
│       ├── ensemble-worker.md
│       └── thinking-hard.md
└── src/
    ├── index.ts              # Plugin.define({ id, effect }) entrypoint
    ├── config.ts             # Effect Schema for options & model spec parser
    ├── models.ts             # Virtual provider transform & exact model/variant resolver
    ├── group-manager.ts      # PackGroupManager (Coordinator session + storage mapping)
    ├── runner.ts             # Parallel worker spawner, semaphore, timeout & follow-up runner
    ├── consensus.ts          # Fair quota truncation & stateless generate.text synthesis
    └── messaging.ts          # Phase 2: Shared board, pack_post_message / pack_read_board & auto-injection
```

---

## Phase 1: Subagents Pack Execution

**Implementation status:** Steps 1.1–1.5 are implemented in `src/`, with in-memory plugin integration tests in `test/phase-one.test.ts`. See `README.md` for configuration and current limitations. Live provider execution has not been verified by these tests. Phase 2 messaging and Phase 3 primary-agent execution remain deferred.

### Step 1.1: Project & Effect Plugin Scaffold (`package.json`, `src/config.ts`)
- Configure `package.json` with `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, and peer/dev dependencies on `@opencode/plugin` and `effect`.
- Implement `src/config.ts` using `effect/Schema`:
  - Require `packProviderId` (non-empty string without `/` or `#`).
  - Parse global defaults (`maxConcurrency = 2`, `timeoutMs = 120_000`, `maxWorkersPerRun = 16`, `consensus`).
  - Parse `packs` map and normalize member model specs (`"provider/model#effort"` and `{ provider, model, effort }`), splitting only on the first `/` and optional last `#` so literal `*` characters in model IDs are preserved intact.

### Step 1.2: Virtual Provider & Model Resolver (`src/models.ts`)
- Register `packProviderId` via `ctx.provider.transform` with each configured pack key (`free`, `big-five`, etc.) registered as a `Model.Info` entry.
- Implement `resolvePackWorkers(ctx, packConfig)`:
  - Fetch active catalog via `ctx.model.list()`.
  - Perform **strict case-sensitive** lookup (`m.providerID === spec.provider && m.id === spec.model`).
  - Log a warning (`Effect.logWarning`) and skip any entry that is missing or disabled.
  - Preserve duplicate entries as distinct workers (`worker-1`, `worker-2`, ...) up to `maxWorkersPerRun`.
  - Check whether `spec.effort` matches a defined variant on `Model.Info.variants`; if not, mark `useHookEffort: true` so `ctx.session.hook("context")` sets `event.options.reasoningEffort = spec.effort`.

### Step 1.3: `PackGroupManager` (`src/group-manager.ts`)
- Abstract pack session group management behind `PackGroupManager`:
  - `createGroup`: Creates the real Coordinator Session (`ctx.session.create({ title })`), initializes the `PackGroupRecord`, and persists it to `ctx.storage` under `pack_group/<groupSessionID>`.
  - `getGroup`: Looks up `pack_group/<groupSessionID>` from memory cache / `ctx.storage`.
  - `logToCoordinator`: Appends synthetic audit messages (`ctx.session.synthetic({ sessionID: groupSessionID, text, resume: false })`) without triggering LLM execution.

### Step 1.4: Parallel Worker Runner & Consensus (`src/runner.ts`, `src/consensus.ts`)
- Implement `runPackSubagent`:
  - Assert `subagent` permission on the parent session (`ctx.permission.assert`).
  - For a new run, create the group via `PackGroupManager.createGroup` and create $N$ worker sessions (`ctx.session.create`), switching each worker to the target subagent (`ctx.session.switchAgent`) and resolved member model (`ctx.session.switchModel`).
  - For a follow-up run (`sessionID` matches an existing `PackGroupRecord`), reuse the $N$ existing worker sessions.
  - Execute all $N$ workers in parallel using `Effect.forEach` bounded by an `Effect.Semaphore(maxConcurrency)` and per-worker `Effect.timeout(timeoutMs)` (calling `ctx.session.interrupt` on timeout or parent cancellation).
  - Extract the final assistant message from each completed worker via `ctx.session.context`.
  - If at least 1 worker succeeded:
    - **`consensus.enabled === false`**: Format all worker responses (with worker label, status, duration, and worker `sessionID`) and log to the Coordinator Session.
    - **`consensus.enabled === true`**: Resolve consensus model (pack override → global → parent session's active model), apply fair per-worker character quota (`maxInputChars`) with unused-quota redistribution, call `ctx.experimental.generate.text` with `consensus.timeoutMs`, and return **only** the synthesized summary (falling back to the direct multi-worker output with a warning banner if synthesis fails).

### Step 1.5: `subagent` Tool Interception (`src/index.ts`)
- In `ctx.tool.transform`, inspect the built-in `subagent` tool and wrap its `execute` function:
  - Determine if the call targets a pack:
    1. `input.sessionID` belongs to `PackGroupManager`, OR
    2. `input.model` starts with `${packProviderId}/`, OR
    3. `input.model` is omitted and the target `input.agent`'s configured model (from `ctx.agent.get`) has `providerID === packProviderId`.
  - If not a pack call, delegate directly to the original `subagent` tool executor.
  - If a pack call:
    - When `input.background === true`: Fork `runPackSubagent` into plugin scope (`Effect.forkScoped`), immediately return `groupSessionID` to the parent agent, and deliver the final output to the parent session via `ctx.session.synthetic` upon completion.
    - When `input.background !== true`: Yield `runPackSubagent` and return the formatted output (including `sessionID: <groupSessionID>`).

---

## Phase 2: Inter-Agent Communication (`src/messaging.ts`)

### Step 2.1: Shared Board & Tool Definitions
- Register `pack_post_message` (`{ message: string, to?: string }`) and `pack_read_board` (`{}`) in `ctx.tool.transform`.
- In `ctx.session.hook("context")`, keep `pack_post_message` and `pack_read_board` enabled **only** if `event.sessionID` is an active worker in a `PackGroupRecord` with `enableInterAgentMessaging: true`; delete them from `event.tools` for all other sessions.

### Step 2.2: Roster Initialization & Live Context Injection
- When spawning workers for a pack with `enableInterAgentMessaging: true`:
  - Populate `<context key="pack-messaging">` on each worker session via `ctx.session.instructions.entry.put` with the worker's own label (`worker-1 (...)`), the full peer roster, and usage instructions for `pack_post_message` / `pack_read_board`.
- When a worker invokes `pack_post_message`:
  - Save the message to the group's board and log it to the Coordinator Session (`resume: false`).
  - Immediately update `<context key="pack-peer-messages">` on all target sibling worker sessions via `ctx.session.instructions.entry.put` so running peers receive the update at their next step boundary without interruption.

---

## Phase 3: Primary Agents Support (Deferred to Separate Session)
- Conduct PoC evaluation for primary agent pack UX in a separate planning session.
- Use `ctx.worktree` to isolate workspace mutations per worker when running edit-capable agents in parallel.
