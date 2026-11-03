import { Agent, type Plugin } from "@opencode/plugin/effect";
import type { SessionMessage } from "@opencode/schema/session-message";
import { Cause, DateTime, Effect } from "effect";
import type { Config, PackConfig } from "./config.ts";
import type { WorkerResult } from "./consensus.ts";
import type {
	PackGroupManager,
	PackGroupRecord,
	PackWorkerRecord,
} from "./group-manager.ts";
import { modelRef, resolvePackWorkers } from "./models.ts";
import { SessionID } from "./session-id.ts";

/** Decoded subagent arguments relevant to pack routing and execution. */
export interface PackInput {
	agent?: string;
	model?: string;
	sessionID?: string;
	description?: string;
	prompt: string;
	background?: boolean;
}

/**
 * Read the newest assistant message from this turn, excluding message IDs
 * observed before prompting. Only text parts are returned; an empty newest
 * assistant response is not replaced by an older response from this turn.
 */
export function finalAssistantText(
	messages: readonly SessionMessage.Info[],
	previous: ReadonlySet<string>,
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.type !== "assistant" || previous.has(message.id)) continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return text.trim() ? text : "";
	}
	return "";
}

/**
 * Validate the requested pack and subagent, then either reuse a persisted
 * group or create a coordinator and one native session per resolved member.
 * New groups are not made available for follow-ups until all worker sessions
 * exist and the group has been saved. On incomplete setup, storage and the
 * coordinator are cleaned up; existing groups are never discarded here.
 */
export const prepareGroup = Effect.fn("prepareGroup")(function* (
	ctx: Plugin.Context,
	manager: PackGroupManager["Service"],
	config: Config,
	packId: string,
	input: PackInput,
	parentSessionID: string,
	existing?: PackGroupRecord,
) {
	const pack = Object.hasOwn(config.packs, packId)
		? config.packs[packId]
		: undefined;
	if (!pack) return yield* Effect.fail(new Error(`Unknown pack: ${packId}`));
	if (existing && existing.parentSessionID !== parentSessionID)
		return yield* Effect.fail(
			new Error("Pack follow-up belongs to a different parent session"),
		);
	const agentId = existing?.agentId ?? input.agent;
	if (!agentId)
		return yield* Effect.fail(new Error("Pack subagent requires an agent"));
	const agent = yield* ctx.agent.get({ agentID: Agent.ID.make(agentId) });
	if (agent.data.mode === "primary")
		return yield* Effect.fail(
			new Error("Pack execution requires a subagent-capable agent"),
		);
	if (pack.enableInterAgentMessaging)
		yield* Effect.logWarning(
			`Pack ${packId}: inter-agent messaging is not implemented in Phase 1; workers run independently`,
		);
	if (existing) return { group: existing, pack };
	if (input.sessionID)
		return yield* Effect.fail(
			new Error(`Not a valid pack group sessionID: ${input.sessionID}`),
		);
	const warnings: string[] = [];
	const resolved = yield* resolvePackWorkers(
		ctx,
		pack,
		config.maxWorkersPerRun,
		config.packProviderId,
		warnings,
	);
	if (!resolved.length)
		return yield* Effect.fail(
			new Error(
				`Pack ${packId} has no available workers\n${warnings.join("\n")}`,
			),
		);
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			// Protect creation/cleanup registration from cancellation, but allow
			// interruption while worker sessions are being allocated.
			const group = yield* manager.createGroup({
				packId,
				agentId,
				parentSessionID,
				description: input.description ?? "Subagent run",
				enableInterAgentMessaging: pack.enableInterAgentMessaging,
			});
			group.warnings = warnings;
			return yield* restore(
				Effect.gen(function* () {
					for (const worker of resolved) {
						// Once created, record the ID before any next interruptible step.
						const session = yield* Effect.uninterruptible(
							ctx.session.create({
								parentID: SessionID.make(group.groupSessionID),
								title: worker.label,
								metadata: {
									packModels: {
										role: "worker",
										groupSessionID: group.groupSessionID,
									},
								},
							}),
						);
						group.workers.push({
							...worker,
							sessionID: session.id,
							status: "pending",
						});
					}
					yield* Effect.uninterruptible(manager.save(group));
					return { group, pack };
				}),
			).pipe(
				Effect.onExit((exit) =>
					exit._tag === "Failure"
						? manager.discard(group).pipe(
								Effect.andThen(
									ctx.session.remove({
										sessionID: SessionID.make(group.groupSessionID),
									}),
								),
								Effect.catchCause((cause) =>
									Effect.logWarning(
										"Failed to clean up incomplete pack group",
										Cause.pretty(cause),
									),
								),
							)
						: Effect.void,
				),
			);
		}),
	);
});

/**
 * Run one prompt in an existing native worker session. Failure and timeout
 * become result records, while interruption propagates to the enclosing run.
 * `promptSubmitted` guards a best-effort native interrupt on failed execution
 * because prompt admission may succeed even when the API call reports failure.
 */
export const runWorker = Effect.fn("runWorker")(function* (
	ctx: Plugin.Context,
	group: PackGroupRecord,
	worker: PackWorkerRecord,
	pack: PackConfig,
	prompt: string,
) {
	const start = DateTime.toEpochMillis(yield* DateTime.now);
	const sessionID = SessionID.make(worker.sessionID);
	worker.status = "running";
	let promptSubmitted = false;
	const execution = Effect.gen(function* () {
		yield* ctx.session.switchAgent({
			sessionID,
			agent: Agent.ID.make(group.agentId),
		});
		yield* ctx.session.switchModel({ sessionID, model: modelRef(worker) });
		// Compare message IDs rather than assuming the final context entry is
		// new: follow-ups share a session's prior conversation history.
		const previous = new Set(
			(yield* ctx.session.context({ sessionID })).map((message) => message.id),
		);
		// Submission can fail after the server admits the prompt. Treat it as
		// potentially active before awaiting the response.
		promptSubmitted = true;
		yield* ctx.session.prompt({ sessionID, text: prompt });
		yield* ctx.session.wait({ sessionID });
		const session = yield* ctx.session.get({ sessionID });
		const messages = yield* ctx.session.context({ sessionID });
		const diagnostic = [...messages]
			.reverse()
			.flatMap((message) =>
				message.type === "assistant" &&
				!previous.has(message.id) &&
				message.error
					? [message.error.message]
					: [],
			)[0];
		if (session.outcome === "failed" || session.outcome === "interrupted")
			return yield* Effect.fail(
				new Error(diagnostic ?? `Worker execution ${session.outcome}`),
			);
		const text = finalAssistantText(messages, previous);
		if (!text)
			return yield* Effect.fail(
				new Error("Worker produced no final assistant response"),
			);
		return text;
	}).pipe(
		// The timeout bounds switch/prompt/wait/context as one operation.
		Effect.onExit((exit) =>
			exit._tag === "Failure" && promptSubmitted
				? ctx.session
						.interrupt({ sessionID, resume: false })
						.pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning(
									`Failed to stop unsuccessful pack worker ${worker.sessionID}`,
									Cause.pretty(cause),
								),
							),
						)
				: Effect.void,
		),
		Effect.timeout(pack.timeoutMs),
	);
	const result = yield* execution.pipe(
		Effect.map((text) => ({ status: "succeeded" as const, text })),
		Effect.catch((error) =>
			Effect.sync(() => {
				const timedOut = Cause.isTimeoutError(error);
				return {
					status: timedOut ? ("timed_out" as const) : ("failed" as const),
					text: error instanceof Error ? error.message : String(error),
				};
			}),
		),
	);
	worker.status = result.status;
	return {
		worker,
		...result,
		durationMs: DateTime.toEpochMillis(yield* DateTime.now) - start,
	} satisfies WorkerResult;
});

/** Keep membership warnings and navigation visible even with consensus output. */
export function formatPackOverview(group: PackGroupRecord): string {
	return [
		`sessionID: ${group.groupSessionID}`,
		"Open the coordinator to inspect native worker subagent calls and its final answer. Use the coordinator ID for ensemble follow-ups.",
		...(group.warnings ?? []).map((warning) => `Warning: ${warning}`),
	].join("\n");
}
