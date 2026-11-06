import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	ProviderV3,
} from "@ai-sdk/provider";
import { Agent, Model, type Plugin, Provider } from "@opencode/plugin/effect";
import type { AgentEditor } from "@opencode/plugin/effect/agent";
import type { AISDKHooks } from "@opencode/plugin/effect/aisdk";
import type { ProviderEditor } from "@opencode/plugin/effect/provider";
import type { SessionContext } from "@opencode/plugin/effect/session";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { SessionMessage } from "@opencode/schema/session-message";
import type { Tool } from "@opencode/schema/tool";
import { Cause, Effect, Semaphore } from "effect";
import type { Config, PackConfig } from "./config.ts";
import {
	type WorkerResult,
	fairTruncate,
	fairTruncateTokens,
	formatDirect,
} from "./consensus.ts";
import {
	CONSENSUS_SYSTEM_PROMPT,
	COORDINATOR_AGENT_NAME,
	COORDINATOR_ID_SUFFIX,
	COORDINATOR_MODEL_ID,
	COORDINATOR_PROVIDER_NAME,
	COORDINATOR_SESSION_MARKER,
	COORDINATOR_SYSTEM_PROMPT,
	SCRIPTED_PROVIDER_ID,
	SUBAGENT_TOOL_NAME,
} from "./constants.ts";
import type { PackGroupManager, PackGroupRecord } from "./group-manager.ts";
import { modelRef, resolveModel } from "./models.ts";
import {
	type ParentContextSnapshot,
	parentResultBudget,
} from "./parent-budget.ts";
import { type PackInput, finalAssistantText, runWorker } from "./runner.ts";
import { scriptedModel, scriptedUsage } from "./scripted-model.ts";
import { SessionID } from "./session-id.ts";
import {
	INPUT_TOKEN_SAFETY_RATIO,
	limitResultText,
	resolveTokenLimit,
	tokenEstimator,
	tokenEstimatorWarning,
} from "./token-budget.ts";

interface CoordinatorTurn {
	group: PackGroupRecord;
	pack: PackConfig;
	prompt: string;
	results: Map<string, WorkerResult>;
	claimed: Set<string>;
	semaphore: Semaphore.Semaphore;
	final?: Promise<string>;
	dispatched?: boolean;
}

/** Only this operation can call an external coordinator LLM. */
const generateCoordinatorAnswer = Effect.fn("packModels.generateAnswer")(
	function* (
		ctx: Plugin.Context,
		config: Config,
		turn: CoordinatorTurn,
		resultTokens: number,
	) {
		const results = turn.group.workers
			.map((w) => turn.results.get(w.sessionID))
			.filter((r): r is WorkerResult => !!r);
		const warnings = (turn.group.warnings ?? [])
			.map((w) => `Warning: ${w}`)
			.join("\n");
		const direct = `${warnings}${warnings ? "\n\n" : ""}${formatDirect(results)}`;
		if (
			!turn.pack.consensus.enabled ||
			!results.some((r) => r.status === "succeeded")
		)
			return direct;
		return yield* Effect.gen(function* () {
			let model: Model.Ref | undefined;
			if (turn.pack.consensus.model) {
				const resolved = yield* resolveModel(
					ctx,
					turn.pack.consensus.model,
					config.packProviderId,
				);
				if (!resolved || resolved.useHookEffort)
					return yield* Effect.fail(
						new Error(
							"Consensus model unavailable or effort is not a native variant",
						),
					);
				model = modelRef(resolved);
			} else {
				const parent = yield* ctx.session.get({
					sessionID: SessionID.make(turn.group.parentSessionID),
				});
				model = parent.model;
				if (!model && parent.agent)
					model = (yield* ctx.agent.get({ agentID: parent.agent })).data.model;
				if (!model) {
					const fallback = (yield* ctx.model.default()).data;
					if (fallback)
						model = { providerID: fallback.providerID, id: fallback.id };
				}
			}
			if (!model || model.providerID === config.packProviderId)
				return yield* Effect.fail(
					new Error("Consensus requires a real chat model"),
				);
			const catalogModel = (yield* ctx.model.list()).data.find(
				(candidate) =>
					candidate.providerID === model.providerID &&
					candidate.id === model.id,
			);
			if (!catalogModel)
				return yield* Effect.fail(
					new Error("Consensus model is not in the catalog"),
				);
			const estimator = tokenEstimator(model.providerID, model.id);
			const estimatorWarning = tokenEstimatorWarning(
				model.providerID,
				model.id,
				estimator,
			);
			if (estimatorWarning) yield* Effect.logWarning(estimatorWarning);
			const newEstimatorWarning =
				estimatorWarning && !turn.group.warnings?.includes(estimatorWarning)
					? estimatorWarning
					: undefined;
			const successful = results.filter((r) => r.status === "succeeded");
			// Legacy character limits are honored only when explicitly configured.
			const evidence = successful.map((r) => r.text);
			const charLimited =
				turn.pack.consensus.maxInputChars === null
					? evidence
					: fairTruncate(evidence, turn.pack.consensus.maxInputChars);
			// Reserve instructions, the unchanged original task and worker labels before
			// dividing the remaining model input allowance among evidence bodies.
			// The host text API has no output-token parameter; this is guidance only.
			const concise = `Keep the answer concise: target at most ${resultTokens} tokens measured by the parent model. Preserve essential conclusions and uncertainty.`;
			const fixedPrompt = `${CONSENSUS_SYSTEM_PROMPT}\n${concise}\n\nOriginal task:\n${turn.prompt}\n\nWorker evidence:\n${successful.map((r) => `${r.worker.label}:\n`).join("\n\n")}`;
			const declaredInput =
				catalogModel.limit.input ??
				Math.max(0, catalogModel.limit.context - catalogModel.limit.output);
			const safeInput = Math.floor(declaredInput * INPUT_TOKEN_SAFETY_RATIO);
			const evidenceBudget = Math.min(
				resolveTokenLimit(declaredInput, turn.pack.consensus.maxInputToken),
				Math.max(0, safeInput - estimator.count(fixedPrompt)),
			);
			if (evidenceBudget === 0)
				return yield* Effect.fail(
					new Error(
						"Consensus model has no remaining capacity for worker evidence",
					),
				);
			const texts = fairTruncateTokens(
				charLimited,
				evidenceBudget,
				estimator.count,
				estimator.truncate,
			);
			const synthesisPrompt = `${CONSENSUS_SYSTEM_PROMPT}\n${concise}\n\nOriginal task:\n${turn.prompt}\n\nWorker evidence:\n${successful.map((r, i) => `${r.worker.label}:\n${texts[i]}`).join("\n\n")}`;
			// Recount the assembled prompt because token merges can cross boundaries.
			// Never truncate the original task; fail synthesis and retain worker reports.
			if (estimator.count(synthesisPrompt) > safeInput)
				return yield* Effect.fail(
					new Error(
						`Consensus prompt overhead exceeds the safe input limit for ${model.providerID}/${model.id}`,
					),
				);
			const output = yield* ctx.experimental.generate
				.text({
					model,
					prompt: synthesisPrompt,
				})
				.pipe(Effect.timeout(turn.pack.consensus.timeoutMs));
			if (!output.text.trim())
				return yield* Effect.fail(new Error("Consensus returned empty text"));
			const diagnostics = results.filter((r) => r.status !== "succeeded");
			return [
				warnings,
				newEstimatorWarning ? `Warning: ${newEstimatorWarning}` : "",
				diagnostics.length ? formatDirect(diagnostics) : "",
				output.text,
			]
				.filter(Boolean)
				.join("\n\n");
		}).pipe(
			Effect.catchCauseIf(
				(cause) => !Cause.hasInterrupts(cause),
				() =>
					Effect.succeed(
						`Warning: consensus synthesis failed; returning individual worker responses.\n\n${direct}`,
					),
			),
		);
	},
);

/** Native coordinator tool calls are transcript entries; only execution is routed. */
export function makeCoordinatorRuntime(
	ctx: Plugin.Context,
	manager: PackGroupManager["Service"],
	config: Config,
	parentSnapshots: ReadonlyMap<string, ParentContextSnapshot> = new Map(),
) {
	const turns = new Map<string, CoordinatorTurn>();
	const scriptedProviderID = `${config.packProviderId}${COORDINATOR_ID_SUFFIX}`;
	const coordinatorAgent = Agent.ID.make(scriptedProviderID);
	const install = Effect.gen(function* () {
		yield* ctx.agent.transform((editor: AgentEditor) => {
			if (editor.get(coordinatorAgent))
				throw new Error(
					`Coordinator agent ID already exists: ${coordinatorAgent}`,
				);
			// update creates a fresh agent when the ID is absent. Do not clone a
			// built-in agent or inherit its permissions, prompt, or plan state.
			editor.update(coordinatorAgent, (agent) => {
				agent.name = Agent.Name.make(COORDINATOR_AGENT_NAME);
				agent.description =
					"Internal static dispatcher for model-pack workers.";
				agent.mode = "subagent";
				agent.hidden = true;
				agent.model = {
					providerID: Provider.ID.make(scriptedProviderID),
					id: Model.ID.make(COORDINATOR_MODEL_ID),
				};
				agent.system = COORDINATOR_SYSTEM_PROMPT;
				agent.permissions = [
					{ action: "*", resource: "*", effect: "deny" },
					{ action: SUBAGENT_TOOL_NAME, resource: "*", effect: "allow" },
				];
			});
		});
		yield* ctx.provider.transform((editor: ProviderEditor) => {
			if (editor.get(scriptedProviderID))
				throw new Error(
					`Coordinator provider ID already exists: ${scriptedProviderID}`,
				);
			const providerID = Provider.ID.make(scriptedProviderID);
			editor.add({
				info: {
					...Provider.Info.empty(providerID),
					name: COORDINATOR_PROVIDER_NAME,
					activation: "enabled",
					package: `aisdk:${SCRIPTED_PROVIDER_ID}`,
				},
				models: [
					{
						...Model.Info.default(
							providerID,
							Model.ID.make(COORDINATOR_MODEL_ID),
						),
						name: COORDINATOR_PROVIDER_NAME,
					},
				],
			});
		});
		yield* ctx.aisdk.hook("sdk", (event: AISDKHooks["sdk"]) =>
			Effect.sync(() => {
				if (event.model.providerID !== scriptedProviderID) return;
				event.sdk = {
					languageModel: (id: string): LanguageModelV3 =>
						scriptedModel(
							id,
							async (
								options: LanguageModelV3CallOptions,
							): Promise<LanguageModelV3GenerateResult> => {
								const marker = options.prompt.find(
									(message) =>
										message.role === "system" &&
										message.content.startsWith(COORDINATOR_SESSION_MARKER),
								);
								const sessionID =
									marker?.role === "system"
										? marker.content
												.split("\n")[0]
												?.slice(COORDINATOR_SESSION_MARKER.length)
										: undefined;
								const turn = sessionID ? turns.get(sessionID) : undefined;
								if (!turn)
									throw new Error("Static coordinator has no active pack turn");
								const remaining = turn.group.workers.filter(
									(w) => !turn.claimed.has(w.sessionID),
								);
								if (remaining.length) {
									if (turn.dispatched)
										throw new Error(
											"Static coordinator dispatch failed: worker calls were not executed. Check coordinator subagent permissions and tool availability.",
										);
									turn.dispatched = true;
									return {
										content: remaining.map((w) => ({
											type: "tool-call",
											toolName: SUBAGENT_TOOL_NAME,
											toolCallId: `pack-${w.workerId}-${crypto.randomUUID()}`,
											input: JSON.stringify({
												agent: turn.group.agentId,
												sessionID: w.sessionID,
												description: w.label,
												prompt: turn.prompt,
											}),
										})),
										finishReason: { unified: "tool-calls", raw: "tool_calls" },
										usage: scriptedUsage,
										warnings: [],
									};
								}
								if (turn.results.size !== turn.group.workers.length)
									throw new Error(
										"Static coordinator worker calls did not all complete",
									);
								// Memoize before awaiting: native retries can never trigger another
								// external synthesis call in this turn.
								turn.final ??= Effect.runPromise(
									Effect.gen(function* () {
										const budget = yield* parentResultBudget(
											ctx,
											turn.group.parentSessionID,
											turn.pack.consensus,
											parentSnapshots.get(turn.group.parentSessionID),
										);
										if (budget.tokens < 64)
											return insufficientParentBudgetNotice(
												turn.group.groupSessionID,
												budget.tokens,
											);
										const text = yield* generateCoordinatorAnswer(
											ctx,
											config,
											turn,
											budget.tokens,
										);
										return limitResultText(
											text,
											budget.tokens,
											budget.estimator,
											turn.group.groupSessionID,
										);
									}),
									{ signal: options.abortSignal },
								);
								return {
									content: [{ type: "text", text: await turn.final }],
									finishReason: { unified: "stop", raw: "stop" },
									usage: scriptedUsage,
									warnings: [],
								};
							},
						),
				} satisfies Pick<ProviderV3, "languageModel">;
			}),
		);
		yield* ctx.session.hook("context", (event: SessionContext) =>
			Effect.sync(() => {
				const turn = turns.get(event.sessionID);
				if (!turn) return;
				for (const name of Object.keys(event.tools))
					if (name !== SUBAGENT_TOOL_NAME) delete event.tools[name];
				// Coordinators add one nesting level. Expose the registered tool even
				// when the default depth filter omitted it; dispatch checks permissions.
				if (!event.tools[SUBAGENT_TOOL_NAME])
					event.tools[SUBAGENT_TOOL_NAME] = {
						description: "Pack worker",
						input: {},
					};
				const subagent = event.tools[SUBAGENT_TOOL_NAME];
				if (subagent) {
					subagent.description =
						"Run one pack worker. Call each listed sessionID exactly once. Calls may be parallel; the plugin enforces concurrency. After every worker returns, write the final answer without more tool calls.";
					subagent.input = {
						type: "object",
						properties: {
							agent: { type: "string", enum: [turn.group.agentId] },
							sessionID: {
								type: "string",
								enum: turn.group.workers.map((w) => w.sessionID),
							},
							description: { type: "string" },
							prompt: {
								type: "string",
								description: "Original task; the plugin sends it unchanged.",
							},
						},
						required: ["agent", "sessionID", "description", "prompt"],
						additionalProperties: false,
					};
				}
				// No parent/plan system instructions are passed to the local adapter.
				event.system = [
					{
						type: "text",
						text: [
							`${COORDINATOR_SESSION_MARKER}${event.sessionID}`,
							COORDINATOR_SYSTEM_PROMPT,
						].join("\n"),
					},
				];
			}),
		);
	});

	const dispatch = (input: PackInput, context: Tool.Context) => {
		const turn = turns.get(context.sessionID);
		if (!turn) return undefined;
		return Effect.gen(function* () {
			const worker = turn.group.workers.find(
				(w) => w.sessionID === input.sessionID,
			);
			if (
				!worker ||
				input.background ||
				(input.agent && input.agent !== turn.group.agentId) ||
				input.model
			)
				return yield* Effect.fail(
					new ToolError({
						message:
							"Coordinator calls must select a listed worker sessionID, its original agent, no model override, and foreground execution.",
					}),
				);
			if (turn.claimed.has(worker.sessionID))
				return yield* Effect.fail(
					new ToolError({ message: "Worker already called for this turn." }),
				);
			yield* ctx.permission.assert({
				sessionID: context.sessionID,
				agent: context.agent,
				action: SUBAGENT_TOOL_NAME,
				resources: [turn.group.agentId],
				source: { type: "tool", messageID: context.messageID, id: context.id },
			});
			turn.claimed.add(worker.sessionID);
			yield* context.progress({
				sessionID: worker.sessionID,
				status: "running",
			});
			const result = yield* turn.semaphore.withPermit(
				runWorker(ctx, turn.group, worker, turn.pack, turn.prompt),
			);
			turn.results.set(worker.sessionID, result);
			yield* manager.save(turn.group);
			const text = formatDirect([result]);
			return {
				output: {
					sessionID: worker.sessionID,
					status: "completed",
					output: text,
				},
				content: `<subagent sessionID="${worker.sessionID}" state="completed">\n${text}\n</subagent>`,
				metadata: { sessionID: worker.sessionID, status: "completed" },
			} satisfies Tool.Result;
		});
	};

	const run = Effect.fn("packModels.coordinator")(function* (
		group: PackGroupRecord,
		pack: PackConfig,
		prompt: string,
	) {
		const sessionID = SessionID.make(group.groupSessionID);
		const model: Model.Ref = {
			providerID: Provider.ID.make(scriptedProviderID),
			id: Model.ID.make(COORDINATOR_MODEL_ID),
		};
		const turn: CoordinatorTurn = {
			group,
			pack,
			prompt,
			results: new Map(),
			claimed: new Set(),
			semaphore: yield* Semaphore.make(pack.maxConcurrency),
		};
		for (const worker of group.workers) worker.status = "pending";
		turns.set(group.groupSessionID, turn);
		return yield* Effect.gen(function* () {
			yield* ctx.session.switchAgent({
				sessionID,
				agent: Agent.ID.make(coordinatorAgent),
			});
			yield* ctx.session.switchModel({ sessionID, model });
			for (let attempt = 0; attempt < 1; attempt++) {
				const previous = new Set(
					(yield* ctx.session.context({ sessionID })).map((m) => m.id),
				);
				yield* ctx.session.prompt({
					sessionID,
					text: prompt,
				});
				yield* ctx.session.wait({ sessionID });
				const session = yield* ctx.session.get({ sessionID });
				const messages = yield* ctx.session.context({ sessionID });
				if (session.outcome === "failed" || session.outcome === "interrupted")
					return yield* Effect.fail(
						new Error(
							coordinatorFailure(group, session.outcome, messages, previous),
						),
					);
				const text = finalAssistantText(messages, previous);
				if (turn.results.size === group.workers.length && text.trim()) {
					if (![...turn.results.values()].some((r) => r.status === "succeeded"))
						return yield* Effect.fail(
							new Error(
								`All pack workers failed.\nsessionID: ${group.groupSessionID}\n${formatDirect([...turn.results.values()])}\n${text}`,
							),
						);
					return text;
				}
			}
			return yield* Effect.fail(
				new Error(
					"Static coordinator did not run every worker and produce a final answer",
				),
			);
		}).pipe(
			Effect.onExit((exit) =>
				exit._tag === "Failure"
					? ctx.session
							.interrupt({ sessionID, resume: false })
							.pipe(
								Effect.catchCause((cause) =>
									Effect.logWarning(
										"Failed to interrupt coordinator",
										Cause.pretty(cause),
									),
								),
							)
					: Effect.void,
			),
			Effect.ensuring(
				Effect.gen(function* () {
					turns.delete(group.groupSessionID);
					for (const worker of group.workers) {
						if (worker.status === "running")
							yield* ctx.session
								.interrupt({
									sessionID: SessionID.make(worker.sessionID),
									resume: false,
								})
								.pipe(
									Effect.catchCause((cause) =>
										Effect.logWarning(
											"Failed to stop coordinator worker",
											Cause.pretty(cause),
										),
									),
								);
						if (worker.status === "running" || worker.status === "pending")
							worker.status = "cancelled";
					}
					yield* manager.save(group);
				}),
			),
			Effect.timeout(
				pack.timeoutMs * group.workers.length + pack.consensus.timeoutMs,
			),
		);
	});
	return { install, dispatch, run };
}

/** Preserve completion and navigation even when a full result cannot fit. */
export function insufficientParentBudgetNotice(
	sessionID: string,
	tokens: number,
): string {
	return `Pack completed, but the parent has insufficient result capacity (${tokens} estimated tokens). Compact the parent context and inspect the coordinator: ${sessionID}`;
}

/** Include persisted provider diagnostics without dumping headers or bodies. */
export function coordinatorFailure(
	group: PackGroupRecord,
	outcome: string,
	messages: readonly SessionMessage.Info[],
	previous: ReadonlySet<string>,
): string {
	const error = [...messages]
		.reverse()
		.find(
			(message) =>
				!previous.has(message.id) &&
				(message.type === "assistant" || message.type === "idle") &&
				message.error,
		);
	const diagnostic =
		error && (error.type === "assistant" || error.type === "idle")
			? error.error
			: undefined;
	return [
		`Coordinator execution ${outcome}. sessionID: ${group.groupSessionID}`,
		...(diagnostic ? [`${diagnostic.type}: ${diagnostic.message}`] : []),
		`Workers completed: ${group.workers.filter((w) => w.status === "succeeded").length}/${group.workers.length}. Open the coordinator to inspect native worker calls and their results.`,
	].join("\n");
}
