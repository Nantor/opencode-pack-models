# Current implementation

The plugin runs on the OpenCode V2 Effect plugin API. Packs are subagent selection targets, not primary chat models.

## Native session hierarchy

```text
Parent conversation
└── Pack coordinator (real agent/model turn)
    ├── Native subagent call → worker/model A session
    ├── Native subagent call → worker/model B session
    └── Final assistant answer → returned unchanged to parent
```

The coordinator is a native session driven by a **local scripted model adapter**, not an LLM agent. The adapter emits fixed tool calls and the final text through OpenCode's normal loop, so OpenCode persists native clickable subagent calls and a final assistant message. There is no custom TUI, direct transcript/database modification, or LLM-driven dispatch. Native tool progress/result metadata points to the actual child sessions.

## Module map

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Decode plugin options and merge defaults. |
| `src/models.ts` | Advertise virtual pack models and resolve enabled catalog models. |
| `src/index.ts` | Route subagent calls, manage active groups, effort hooks and background execution. |
| `src/coordinator.ts` | Run the real coordinator, constrain its tools, route its worker calls and validate completion. |
| `src/scripted-model.ts` | Local AI SDK V3 adapter emitting fixed native tool/text events with zero coordinator-model usage. |
| `src/group-manager.ts` | Persist coordinator/worker membership and reverse indexes. |
| `src/runner.ts` | Allocate sessions and execute workers with timeouts and cancellation cleanup. |
| `src/consensus.ts` | Format worker tool results; retain the fair-truncation utility. |
| `src/session-id.ts` | Brand native session IDs for host calls. |

## Selection and execution

The plugin wraps the native `subagent` tool. Explicit `<packProviderId>/<packId>` models select packs; absent an explicit model, an agent's configured pack model selects its pack. Non-pack calls delegate to the original executor. Explicit real-model overrides intentionally bypass the pack.

Pack calls check parent subagent permissions and validate the worker agent. Members match enabled catalog models exactly and case-sensitively. Unavailable models are skipped and warnings are stored with the group; cap omissions are also recorded. Duplicate members are independent workers. An all-unavailable pack fails before creating sessions.

The plugin preallocates the coordinator and worker sessions. It registers a dedicated hidden `<packProviderId>-coordinator` agent in subagent mode using an agent transform. This fresh agent has static coordinator-only instructions, the local static model, and a deny-all ruleset with an explicit subagent allow rule. It does not clone, reuse, or modify any built-in agent. A preexisting agent ID is rejected rather than overwritten; the registration is scoped to the plugin lifecycle. Its model is `<packProviderId>-coordinator/static`, an in-process adapter registered using the AI SDK hook. No credentials, HTTP requests or LLM tokens are needed for dispatch and transcript recording. The parent retains its current agent (including plan), and worker agents remain unchanged. Session permission restrictions still apply. The adapter emits the dispatch batch only once; missing/denied tool execution fails immediately instead of looping. Context-hook descriptions alone cannot override executable tool filtering.

The coordinator's context hook exposes only `subagent`, with a stable definition listing the group's worker IDs throughout the turn. The scripted adapter emits one fixed call per member in configured order, all in the initial dispatch step. Dispatch independently rejects extra workers, duplicates, agent/model changes and background worker calls, and checks subagent permission. Every worker receives the original task unchanged. A semaphore enforces `maxConcurrency` regardless of the number of emitted calls.

Workers keep their configured agent and actual pack model. Native effort variants travel with the model; non-native worker efforts use a scoped `reasoningEffort` hook. Worker execution is bounded by `timeoutMs` and reads the newest new assistant text. Provider failures, empty responses and timeouts become diagnostic tool results so other workers can finish. Failed submissions attempt a native interrupt before releasing the permit.

After every worker result is collected, the local adapter emits a nonempty final answer. There are no corrective prompts or autonomous coordinator iterations. All-worker failure rejects with diagnostics and makes no synthesis request. Final foreground `output.output` is exactly the coordinator's final assistant text; content uses the native subagent wrapper, with coordinator `sessionID`/status metadata.

Coordinator failure reports include its session ID, successful worker count, and the newest new persisted provider error type/message. Raw response bodies and headers are not copied into tool errors. Worker conversations remain inspectable even if the final coordinator request fails.

## Final-answer policy and cost

With `consensus.enabled: false`, the final answer is a deterministic labelled report of every worker response and status, with skipped-member warnings. The coordinator makes **zero external LLM calls**; only workers use their models.

With `consensus.enabled: true` and at least one successful worker, exactly one `experimental.generate.text` call uses a fixed synthesis prompt and successful worker evidence. There are no tools, sessions or plan-agent instructions in that synthesis request. Its model is explicit `consensus.model`, or the parent's active model, its agent model, then the workspace default. Explicit efforts must be native variants. Omissions/failures are prepended deterministically to the synthesis answer. The final-answer promise is memoized per turn so replay/retry cannot trigger a second synthesis call. Synthesis failure/timeout falls back to the deterministic worker report; interruption propagates without fallback.

The total deadline is `worker timeoutMs × worker count + consensus.timeoutMs`. `consensus.timeoutMs` also bounds the single synthesis call; `consensus.maxInputChars` fairly budgets successful worker evidence bodies. Full worker tool results and transcripts remain untruncated. Local adapter dispatch/final events have zero token usage; the synthesis API's usage is separate from coordinator transcript usage.

## Follow-ups, background and cancellation

The returned ID is the coordinator ID. Parent follow-ups reuse coordinator and worker histories with fixed membership. They must originate from the original parent and cannot change the pack or worker agent. Direct worker follow-ups through the parent tool are rejected. Concurrent turns on a group are rejected.

Background calls acknowledge the coordinator ID immediately, run in the plugin scope, and notify the parent on completion. Cancellation stops the coordinator and unfinished workers, clears scoped routing/effort state, persists cancelled statuses and does not notify/resume the parent. Background jobs are plugin-scoped, not durable restart-recoverable native jobs.

Group storage uses `pack_group/<coordinator ID>` and `pack_worker/<worker ID>`. Incomplete allocation discards mapping and removes the coordinator tree. Older groups can be resumed: their queued audit notices may be drained as history, but only new native tool results count toward the current turn.

## Build and limitations

`bun run build` emits explicit `dist/server.ts` and `dist/index.ts` entrypoints plus the bundled server. Atomic replacement prevents reload watchers reading truncated files. No nested package manifest or TUI part is generated.

Inter-agent messaging, primary-agent packs, isolated worktrees and durable background recovery are not implemented. Parallel workers share a workspace. Tests exercise the actual scripted adapter with an in-memory host, streaming event checks and resolver checks; rendered native navigation and host AI SDK integration still require live testing.
