import { Agent, Plugin } from "@opencode/plugin/effect";
import type { SessionContext } from "@opencode/plugin/effect/session";
import type { ToolEditor } from "@opencode/plugin/effect/tool";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { Tool } from "@opencode/schema/tool";
import { Cause, Effect, Schema } from "effect";
import { decodeConfig } from "./config.ts";
import { PLUGIN_ID, SUBAGENT_TOOL_NAME } from "./constants.ts";
import {
	insufficientParentBudgetNotice,
	makeCoordinatorRuntime,
} from "./coordinator.ts";
import { makeGroupManager } from "./group-manager.ts";
import { registerProvider } from "./models.ts";
import {
	type ParentContextSnapshot,
	parentResultBudget,
} from "./parent-budget.ts";
import { formatPackOverview, type PackInput, prepareGroup } from "./runner.ts";
import { SessionID } from "./session-id.ts";
import {
	estimateRequestTokens,
	INPUT_TOKEN_SAFETY_RATIO,
	limitResultText,
	tokenEstimator,
} from "./token-budget.ts";

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
	const parentSnapshots = new Map<string, ParentContextSnapshot>();
	const coordinator = makeCoordinatorRuntime(
		ctx,
		manager,
		config,
		parentSnapshots,
	);
	// Plugin-instance state: prevent concurrent turns on the same group and
	// scope non-native reasoning effort to currently running worker sessions.
	const active = new Set<string>();
	// A session becomes snapshot-relevant only after it actually invokes a pack.
	// Its first run uses the history fallback; later outbound turns get full snapshots.
	const packParents = new Set<string>();
	const efforts = new Map<string, string>();
	// Scope admission checks to active pack workers, never parent/coordinator turns.
	const tokenLimits = new Map<
		string,
		{ providerID: string; modelID: string; input: number }
	>();
	yield* registerProvider(ctx, config);
	yield* coordinator.install;
	yield* ctx.session.hook("context", (event: SessionContext) =>
		Effect.gen(function* () {
			const limit = tokenLimits.get(event.sessionID);
			const effort = efforts.get(event.sessionID);
			if (effort) event.options["reasoningEffort"] = effort;
			// Internal worker requests are estimated once below and never enter the
			// parent cache. Coordinator requests use the local scripted provider.
			if (
				!limit &&
				packParents.has(event.sessionID) &&
				event.model &&
				event.system &&
				event.messages &&
				event.tools
			) {
				const estimator = tokenEstimator(
					event.model.providerID,
					event.model.id,
				);
				// Outbound messages are provider-ready; context() returns stored rows.
				// Use the same stored representation as parentResultBudget's growth check.
				const history = yield* ctx.session
					.context({
						sessionID: SessionID.make(event.sessionID),
					})
					.pipe(Effect.orDie);
				parentSnapshots.set(event.sessionID, {
					model: event.model,
					tokens: estimateRequestTokens(estimator, event),
					historyTokens: estimator.count(JSON.stringify(history)),
				});
				if (parentSnapshots.size > 256) {
					const oldest = parentSnapshots.keys().next().value;
					if (oldest) parentSnapshots.delete(oldest);
				}
			}
			if (!limit) return;
			const estimator = tokenEstimator(limit.providerID, limit.modelID);
			// Check every outbound worker context, not just the newest user prompt:
			// follow-up history and newly accumulated tool results also consume input.
			const estimated = estimateRequestTokens(estimator, {
				system: event.system ?? [],
				messages: event.messages ?? [],
				tools: event.tools ?? {},
			});
			const safeLimit = Math.floor(limit.input * INPUT_TOKEN_SAFETY_RATIO);
			if (estimated > safeLimit)
				return yield* Effect.die(
					new Error(
						`Estimated worker input (${estimated} tokens using ${estimator.modelName}; ${estimator.confidence}) exceeds the heuristic limit (${safeLimit}; ${INPUT_TOKEN_SAFETY_RATIO * 100}% of ${limit.input}) for ${limit.providerID}/${limit.modelID}. This is not a provider-validated token count.`,
					),
				);
		}),
	);
	yield* ctx.tool.transform((editor: ToolEditor) => {
		editor.update(SUBAGENT_TOOL_NAME, (tool) => {
			const original = tool.execute;
			tool.execute = (
				raw: unknown,
				context: Tool.Context,
			): ReturnType<Tool.Info["execute"]> =>
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
					// Register the parent before preparation/run so its next outbound context
					// refreshes the snapshot. Worker contexts use tokenLimits, not this set;
					// prepareGroup creates sessions, and coordinator.run starts requests below.
					packParents.add(context.sessionID);
					// Reservation, preparation, catalog recovery and runtime-map setup share
					// one failure/cancellation boundary so follow-ups can never stay reserved.
					const { group, pack } = yield* Effect.gen(function* () {
						if (existing) active.add(existing.groupSessionID);
						const prepared = yield* prepareGroup(
							ctx,
							manager,
							config,
							packId,
							input,
							context.sessionID,
							existing,
						);
						const needsCatalog = prepared.group.workers.some(
							(worker) => worker.inputTokenLimit === undefined,
						);
						const workerCatalog = needsCatalog
							? (yield* ctx.model.list()).data
							: [];
						active.add(prepared.group.groupSessionID);
						for (const worker of prepared.group.workers) {
							if (worker.useHookEffort && worker.effort)
								efforts.set(worker.sessionID, worker.effort);
							const catalogModel = workerCatalog.find(
								(candidate) =>
									candidate.providerID === worker.providerID &&
									candidate.id === worker.modelID,
							);
							const inputTokenLimit =
								worker.inputTokenLimit ??
								(catalogModel
									? (catalogModel.limit.input ??
										Math.max(
											0,
											catalogModel.limit.context - catalogModel.limit.output,
										))
									: undefined);
							if (inputTokenLimit !== undefined)
								tokenLimits.set(worker.sessionID, {
									providerID: worker.providerID,
									modelID: worker.modelID,
									input: inputTokenLimit,
								});
						}
						return prepared;
					}).pipe(
						Effect.onExit((exit) =>
							exit._tag === "Failure"
								? Effect.sync(() => {
										const failedGroupID = existing?.groupSessionID;
										if (failedGroupID) active.delete(failedGroupID);
										for (const worker of existing?.workers ?? []) {
											efforts.delete(worker.sessionID);
											tokenLimits.delete(worker.sessionID);
										}
									})
								: Effect.void,
						),
					);
					const run = context
						.progress({ sessionID: group.groupSessionID, status: "running" })
						.pipe(
							Effect.andThen(coordinator.run(group, pack, input.prompt)),
							Effect.ensuring(
								Effect.sync(() => {
									active.delete(group.groupSessionID);
									for (const worker of group.workers)
										efforts.delete(worker.sessionID);
									for (const worker of group.workers)
										tokenLimits.delete(worker.sessionID);
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
								Effect.gen(function* () {
									// Parent history may have grown while a background pack was running.
									const budget = yield* parentResultBudget(
										ctx,
										context.sessionID,
										pack.consensus,
										parentSnapshots.get(context.sessionID),
									);
									if (budget.tokens < 64) {
										yield* ctx.session.synthetic({
											sessionID: context.sessionID,
											text: insufficientParentBudgetNotice(
												group.groupSessionID,
												budget.tokens,
											),
											description: "Pack coordinator finished",
											metadata: {
												source: SUBAGENT_TOOL_NAME,
												childID: group.groupSessionID,
												agent: group.agentId,
												state: "completed",
											},
											resume: true,
										});
										return;
									}
									yield* ctx.session.synthetic({
										sessionID: context.sessionID,
										text: limitResultText(
											text,
											budget.tokens,
											budget.estimator,
											group.groupSessionID,
										),
										description: "Pack coordinator finished",
										metadata: {
											source: SUBAGENT_TOOL_NAME,
											childID: group.groupSessionID,
											agent: group.agentId,
											state: "completed",
										},
										resume: true,
									});
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
