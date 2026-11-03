import { Agent, Plugin } from "@opencode/plugin/effect";
import type { SessionContext } from "@opencode/plugin/effect/session";
import type { ToolEditor } from "@opencode/plugin/effect/tool";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { Tool } from "@opencode/schema/tool";
import { Cause, Effect, Schema } from "effect";
import { decodeConfig } from "./config.ts";
import { PLUGIN_ID, SUBAGENT_TOOL_NAME } from "./constants.ts";
import { makeCoordinatorRuntime } from "./coordinator.ts";
import { makeGroupManager } from "./group-manager.ts";
import { registerProvider } from "./models.ts";
import { type PackInput, formatPackOverview, prepareGroup } from "./runner.ts";

/**
 * Effect-native plugin entry point. The virtual provider only advertises
 * packs; intercepted subagent calls execute the real provider models. Calls
 * that do not select a pack are delegated to the original subagent tool.
 */

// Decode the subset of subagent arguments needed for routing; pass the raw
// input through unchanged when dispatching to the original tool.
const SubagentInput = Schema.Struct({
	agent: Schema.optionalKey(Schema.String),
	model: Schema.optionalKey(Schema.String),
	sessionID: Schema.optionalKey(Schema.String),
	description: Schema.optionalKey(Schema.String),
	prompt: Schema.String,
	background: Schema.optionalKey(Schema.Boolean),
});

/** Install provider, worker-only effort hook, and subagent tool interception. */
export const setup = Effect.fn("packModels.setup")(function* (
	ctx: Plugin.Context,
) {
	const config = yield* decodeConfig(ctx.options).pipe(Effect.orDie);
	const scope = yield* Effect.scope;
	const manager = makeGroupManager(ctx);
	const coordinator = makeCoordinatorRuntime(ctx, manager, config);
	// Plugin-instance state: prevent concurrent turns on the same group and
	// scope non-native reasoning effort to currently running worker sessions.
	const active = new Set<string>();
	const efforts = new Map<string, string>();
	yield* registerProvider(ctx, config);
	yield* coordinator.install;
	yield* ctx.session.hook("context", (event: SessionContext) =>
		Effect.sync(() => {
			const effort = efforts.get(event.sessionID);
			if (effort) event.options.reasoningEffort = effort;
		}),
	);
	yield* ctx.tool.transform((editor: ToolEditor) => {
		editor.update(SUBAGENT_TOOL_NAME, (tool) => {
			const original = tool.execute;
			tool.execute = (raw: unknown, context: Tool.Context) =>
				Effect.gen(function* () {
					const input: PackInput =
						yield* Schema.decodeUnknownEffect(SubagentInput)(raw);
					const workerCall = coordinator.dispatch(input, context);
					if (workerCall) return yield* workerCall;
					// An existing coordinator ID takes precedence over model/agent
					// selection. Explicit model changes are rejected below.
					const existing = input.sessionID
						? yield* manager.getGroup(input.sessionID)
						: undefined;
					let packId = existing?.packId;
					const prefix = `${config.packProviderId}/`;
					const explicitPack = input.model?.startsWith(prefix) ?? false;
					if (!packId && input.model?.startsWith(prefix))
						packId = input.model.slice(prefix.length);
					if (!packId && !input.model && input.agent) {
						const agent = yield* ctx.agent.get({
							agentID: Agent.ID.make(input.agent),
						});
						if (agent.data.model?.providerID === config.packProviderId)
							packId = agent.data.model.id;
					}
					if (input.sessionID && !existing) {
						// Worker IDs are for inspection only; unknown pack group IDs
						// must not accidentally create a new group.
						const owner = yield* manager.getWorkerGroup(input.sessionID);
						if (owner)
							return yield* Effect.fail(
								new Error(
									`Worker session cannot be resumed directly; use pack group sessionID: ${owner}`,
								),
							);
						if (packId !== undefined || explicitPack)
							return yield* Effect.fail(
								new Error(
									`Not a valid pack group sessionID: ${input.sessionID}`,
								),
							);
					}
					if (
						existing &&
						((input.model !== undefined &&
							input.model !== `${prefix}${existing.packId}`) ||
							(input.agent !== undefined && input.agent !== existing.agentId))
					) {
						return yield* Effect.fail(
							new Error("Pack follow-up cannot change its model or agent"),
						);
					}
					if (packId === undefined && !explicitPack)
						return yield* original(raw, context);
					if (!packId)
						return yield* Effect.fail(
							new Error("Pack model requires a pack ID"),
						);
					yield* ctx.permission.assert({
						sessionID: context.sessionID,
						agent: context.agent,
						action: SUBAGENT_TOOL_NAME,
						resources: [existing?.agentId ?? input.agent ?? ""],
						source: {
							type: "tool",
							messageID: context.messageID,
							id: context.id,
						},
					});
					if (existing && active.has(existing.groupSessionID))
						return yield* Effect.fail(
							new Error("Pack group already has an active run"),
						);
					if (existing) active.add(existing.groupSessionID);
					// Reserve existing groups before preparation so concurrent
					// follow-ups cannot run on the same persistent worker sessions.
					const { group, pack } = yield* prepareGroup(
						ctx,
						manager,
						config,
						packId,
						input,
						context.sessionID,
						existing,
					).pipe(
						Effect.onExit((exit) =>
							Effect.sync(() => {
								if (exit._tag === "Failure" && existing)
									active.delete(existing.groupSessionID);
							}),
						),
					);
					active.add(group.groupSessionID);
					for (const worker of group.workers) {
						if (worker.useHookEffort && worker.effort)
							efforts.set(worker.sessionID, worker.effort);
					}
					const run = context
						.progress({ sessionID: group.groupSessionID, status: "running" })
						.pipe(
							Effect.andThen(coordinator.run(group, pack, input.prompt)),
							Effect.ensuring(
								Effect.sync(() => {
									active.delete(group.groupSessionID);
									for (const worker of group.workers)
										efforts.delete(worker.sessionID);
								}),
							),
						);
					if (input.background) {
						// The fiber belongs to the plugin scope rather than this tool
						// invocation. Interruptions never publish a fallback or resume
						// the parent; other failures become a synthetic notification.
						const background = run.pipe(
							Effect.catchCauseIf(
								(cause) => !Cause.hasInterrupts(cause),
								(cause) =>
									Effect.succeed(
										`Pack failed.\nsessionID: ${group.groupSessionID}\n${Cause.pretty(cause)}`,
									),
							),
							Effect.flatMap((text) =>
								ctx.session.synthetic({
									sessionID: context.sessionID,
									text,
									description: "Pack coordinator finished",
									metadata: {
										source: SUBAGENT_TOOL_NAME,
										childID: group.groupSessionID,
										agent: group.agentId,
										state: "completed",
									},
									resume: true,
								}),
							),
							Effect.catchCauseIf(
								(cause) => !Cause.hasInterrupts(cause),
								(cause) =>
									Effect.logWarning(
										"Pack background notification failed",
										Cause.pretty(cause),
									),
							),
						);
						yield* Effect.forkIn(background, scope);
						const text = `Pack running in background.\n${formatPackOverview(group)}`;
						return {
							output: {
								sessionID: group.groupSessionID,
								status: "running",
								output: text,
							},
							content: text,
							metadata: { sessionID: group.groupSessionID, status: "running" },
						} satisfies Tool.Result;
					}
					const text = yield* run;
					return {
						output: {
							sessionID: group.groupSessionID,
							status: "completed",
							output: text,
						},
						content: `<subagent sessionID="${group.groupSessionID}" state="completed">\n${text}\n</subagent>`,
						metadata: { sessionID: group.groupSessionID, status: "completed" },
					} satisfies Tool.Result;
				}).pipe(
					// Preserve native tool errors while presenting plugin errors in
					// the subagent tool's expected error shape.
					Effect.mapError((error) =>
						error instanceof ToolError
							? error
							: new ToolError({
									message:
										error instanceof Error ? error.message : String(error),
								}),
					),
				);
		});
	});
});

export default Plugin.define({ id: PLUGIN_ID, effect: setup });
