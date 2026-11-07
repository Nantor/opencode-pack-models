import { describe, expect, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { Agent, Model, type Plugin, Provider } from "@opencode/plugin/effect";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Session } from "@opencode/schema/session";
import type { Tool } from "@opencode/schema/tool";
import { Effect, Fiber, Schema, type Types } from "effect";
import { setup } from "../src";
import { decodeConfig, parseModelSpec } from "../src/config.ts";
import { fairTruncate, fairTruncateTokens } from "../src/consensus.ts";
import { CONSENSUS_SYSTEM_PROMPT } from "../src/constants.ts";
import { makeGroupManager } from "../src/group-manager.ts";
import { resolvePackWorkers } from "../src/models.ts";
import {
	estimateRequestTokens,
	tokenEstimator,
	tokenEstimatorWarning,
} from "../src/token-budget.ts";

// biome-ignore lint/suspicious/noExportsInTest: Shared in-memory plugin fixture for the review regression suite.
export function harness(options: Record<string, unknown> = {}) {
	// Native subagent tools declare a structured output in addition to content.
	// Enforce that contract at execution, just as the live host does.
	const outputSchema = Schema.Struct({
		sessionID: Session.ID,
		status: Schema.Literals(["completed", "running"]),
		output: Schema.String,
	});
	const stored = new Map<string, Schema.Json>();
	const sessions = new Map<
		string,
		{
			id: Session.ID;
			model?: Model.Ref;
			outcome?: "succeeded" | "failed";
			messages: unknown[];
			metadata?: Record<string, Schema.Json>;
			agent?: Agent.ID;
		}
	>();
	const audit: { sessionID: string; text: string; resume: boolean }[] = [];
	const interrupted: string[] = [];
	const hooks: ((event: {
		sessionID: string;
		options: Record<string, unknown>;
	}) => Effect.Effect<void>)[] = [];
	let executor: Tool.Info["execute"] = () =>
		Effect.succeed({
			output: {
				sessionID: Session.ID.make("ses_native"),
				status: "completed",
				output: "native",
			},
			content: "native",
		});
	let count = 0;
	let running = 0;
	let peak = 0;
	let mode: "success" | "fail" | "timeout" = "success";
	let synthesisFails = false;
	let sdkHook:
		| ((event: {
				model: { providerID: string };
				sdk?: { languageModel: (id: string) => LanguageModelV3 } | undefined;
		  }) => Effect.Effect<void>)
		| undefined;
	let synthesisCalls = 0;
	const synthesisPrompts: string[] = [];
	const prompts: string[] = [];
	const seenEfforts: unknown[] = [];
	const agents = new Map<string, Types.DeepMutable<Agent.Info>>();
	const providerID = Provider.ID.make("p");
	const catalog = ["A*", "B"].map((id) =>
		Model.Info.make({ ...Model.Info.default(providerID, Model.ID.make(id)) }),
	);
	sessions.set("ses_parent", {
		id: Session.ID.make("ses_parent"),
		agent: Agent.ID.make("build"),
		model: { providerID, id: Model.ID.make("A*") },
		messages: [],
	});
	const ctx = {
		options: {
			packProviderId: "packs",
			packs: { pair: { models: ["p/A*#high", "p/B", "p/A*"] } },
			...options,
		},
		aisdk: {
			hook: (_: string, callback: typeof sdkHook) =>
				Effect.sync(() => {
					sdkHook = callback;
				}),
		},
		storage: {
			remove: (key: string) =>
				Effect.sync(() => {
					stored.delete(key);
				}),
			get: (key: string) => Effect.sync(() => stored.get(key)),
			set: (key: string, value: Schema.Json) =>
				Effect.sync(() => {
					stored.set(key, structuredClone(value));
				}),
		},
		model: {
			list: () => Effect.succeed({ data: catalog }),
			default: () => Effect.succeed({ data: catalog[0] }),
		},
		provider: {
			transform: (callback: (editor: unknown) => void) =>
				Effect.sync(() => {
					callback({
						get: () => undefined,
						add: (input: { models: Model.Info[] }) => {
							catalog.push(...input.models);
						},
					});
				}),
		},
		agent: {
			transform: (
				callback: Parameters<Plugin.Context["agent"]["transform"]>[0],
			) =>
				Effect.sync(() => {
					callback({
						list: () => [...agents.values()],
						get: (id) => agents.get(id),
						default: () => {},
						remove: (id) => {
							agents.delete(id);
						},
						update: (id, update) => {
							const agent =
								agents.get(id) ?? Agent.Info.default(Agent.ID.make(id));
							agents.set(id, agent);
							update(agent);
						},
					});
				}),
			get: () =>
				Effect.succeed({
					data: {
						mode: "subagent",
						model: { providerID: "packs", id: "pair" },
					},
				}),
		},
		permission: { assert: () => Effect.void },
		tool: {
			transform: (callback: (editor: unknown) => void) =>
				Effect.sync(() => {
					const tool = { execute: executor, output: outputSchema };
					callback({
						update: (_: string, update: (tool: unknown) => void) =>
							update(tool),
					});
					executor = tool.execute;
				}),
		},
		session: {
			remove: ({ sessionID }: { sessionID: string }) =>
				Effect.sync(() => {
					for (const [id, session] of sessions)
						if (
							id === sessionID ||
							(session as { parentID?: string }).parentID === sessionID
						)
							sessions.delete(id);
				}),
			hook: (_: string, callback: (typeof hooks)[number]) =>
				Effect.sync(() => {
					hooks.push(callback);
				}),
			create: (input: {
				parentID?: string;
				title?: string;
				metadata?: Record<string, Schema.Json>;
			}) =>
				Effect.sync(() => {
					const id = Session.ID.make(`ses_${++count}`);
					const session = { id, messages: [], ...input };
					sessions.set(id, session);
					return session;
				}),
			get: ({ sessionID }: { sessionID: string }) =>
				Effect.sync(() => sessions.get(sessionID)),
			switchAgent: ({
				sessionID,
				agent,
			}: { sessionID: string; agent: Agent.ID }) =>
				Effect.sync(() => {
					const session = sessions.get(sessionID);
					if (session) session.agent = agent;
				}),
			switchModel: ({
				sessionID,
				model,
			}: { sessionID: string; model: Model.Ref }) =>
				Effect.sync(() => {
					const session = sessions.get(sessionID);
					if (session) session.model = model;
				}),
			context: ({ sessionID }: { sessionID: string }) =>
				Effect.sync(() => sessions.get(sessionID)?.messages ?? []),
			prompt: ({ sessionID, text }: { sessionID: string; text: string }) =>
				Effect.gen(function* () {
					const session = sessions.get(sessionID);
					if (
						(session?.metadata?.packModels as { role?: string } | undefined)
							?.role === "coordinator"
					) {
						if (!session) throw new Error("Missing coordinator");
						const event = {
							sessionID,
							options: {},
							tools: { subagent: { description: "native", input: {} } },
							system: [],
						};
						for (const hook of hooks) yield* hook(event);
						const sdkEvent = {
							model: { providerID: String(session.model?.providerID) },
							sdk: undefined as
								| { languageModel: (id: string) => LanguageModelV3 }
								| undefined,
						};
						if (!sdkHook) throw new Error("Missing scripted SDK hook");
						yield* sdkHook(sdkEvent);
						const language = sdkEvent.sdk?.languageModel("static");
						if (!language) throw new Error("Missing scripted model");
						const options = {
							prompt: (event.system as { type: string; text: string }[]).map(
								(part) => ({ role: "system" as const, content: part.text }),
							),
						};
						const dispatch = yield* Effect.promise(() =>
							Promise.resolve(language.doGenerate(options)),
						);
						const calls = dispatch.content.filter(
							(part) => part.type === "tool-call",
						);
						const results = yield* Effect.forEach(
							ctx.options.simulateMissingSubagent ? [] : calls,
							(call) =>
								executor(JSON.parse(call.input), {
									sessionID: Session.ID.make(sessionID),
									agent: session.agent ?? Agent.ID.make("build"),
									messageID: "message" as Tool.Context["messageID"],
									id: call.toolCallId as Tool.CallID,
									progress: () => Effect.void,
								}),
							{ concurrency: "unbounded" },
						);
						const final = yield* Effect.promise(() =>
							Promise.resolve(language.doGenerate(options)),
						);
						session.messages.push({
							id: `coordinator-${prompts.length}`,
							type: "assistant",
							content: [
								...results.map((r) => ({
									type: "tool",
									name: "subagent",
									state: {
										status: "completed",
										metadata: r.metadata,
										content: [{ type: "text", text: r.content }],
									},
								})),
								{
									type: "text",
									text: final.content
										.filter((part) => part.type === "text")
										.map((part) => part.text)
										.join("\n"),
								},
							],
						});
						session.outcome = "succeeded";
						return {};
					}
					prompts.push(text);
					const event = { sessionID, options: {} as Record<string, unknown> };
					for (const hook of hooks) yield* hook(event);
					seenEfforts.push(event.options.reasoningEffort);
					return {};
				}),
			wait: ({ sessionID }: { sessionID: string }) =>
				Effect.gen(function* () {
					if (
						(
							sessions.get(sessionID)?.metadata?.packModels as
								| { role?: string }
								| undefined
						)?.role === "coordinator"
					)
						return;
					running++;
					peak = Math.max(peak, running);
					if (mode === "timeout" && sessions.get(sessionID)?.model?.id === "B")
						yield* Effect.never;
					yield* Effect.sleep(5);
					if (mode === "fail" && sessions.get(sessionID)?.model?.id === "B") {
						const session = sessions.get(sessionID);
						if (session) {
							session.outcome = "failed";
							session.messages.push({
								id: `error-${prompts.length}`,
								type: "assistant",
								content: [],
								error: { message: "429 provider rate limit" },
							});
						}
						return;
					}
					const session = sessions.get(sessionID);
					if (session) {
						session.outcome = "succeeded";
						session.messages.push({
							id: `message-${prompts.length}-${sessionID}`,
							type: "assistant",
							content: [
								{
									type: "text",
									text: `Answer ${prompts.length} from ${sessionID}`,
								},
							],
						});
					}
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							running--;
						}),
					),
				),
			interrupt: ({ sessionID }: { sessionID: string }) =>
				Effect.sync(() => {
					interrupted.push(sessionID);
				}),
			synthetic: (input: (typeof audit)[number]) =>
				Effect.sync(() => {
					audit.push(input);
					return {};
				}),
		},
		experimental: {
			generate: {
				text: (input: { prompt: string }) => {
					synthesisCalls++;
					synthesisPrompts.push(input.prompt);
					return synthesisFails
						? Effect.fail(new Error("synthesis failed"))
						: Effect.succeed({ text: "Synthesized answer" });
				},
			},
		},
	} as unknown as Plugin.Context;
	return {
		ctx,
		agents,
		stored,
		sessions,
		audit,
		interrupted,
		prompts,
		seenEfforts,
		synthesisCalls: () => synthesisCalls,
		synthesisPrompts,
		hooks,
		setMode: (value: typeof mode) => {
			mode = value;
		},
		failSynthesis: () => {
			synthesisFails = true;
		},
		peak: () => peak,
		execute: (input: unknown) =>
			executor(input, {
				sessionID: Session.ID.make("ses_parent"),
				agent: Agent.ID.make("build"),
				messageID: "message" as Tool.Context["messageID"],
				id: "call" as Tool.CallID,
				progress: () => Effect.void,
			}).pipe(
				Effect.tap((result) =>
					Schema.decodeUnknownEffect(outputSchema)(result.output).pipe(
						Effect.mapError(
							(error) =>
								new ToolError({
									message: "Tool did not return its declared output",
									error,
								}),
						),
					),
				),
			),
	};
}

describe("Phase 1 configuration and resolution", () => {
	test("normalizes defaults, overrides and literal model IDs", async () => {
		expect(parseModelSpec("p/path/A*#max")).toEqual({
			provider: "p",
			model: "path/A*",
			effort: "max",
		});
		const config = await Effect.runPromise(
			decodeConfig({
				packProviderId: "packs",
				consensus: { enabled: true, model: "p/A*" },
				packs: { x: { models: ["p/A*"], consensus: { maxInputChars: 20 } } },
			}),
		);
		expect(config.packs.x?.maxConcurrency).toBe(2);
		expect(config.packs.x?.consensus).toEqual({
			enabled: true,
			model: { provider: "p", model: "A*" },
			systemPrompt: CONSENSUS_SYSTEM_PROMPT,
			timeoutMs: 120000,
			maxInputToken: "25%",
			maxResultToken: "25%",
			maxInputTokens: null,
			maxInputPercentage: 25,
			maxResultPercentage: 25,
			maxResultTokens: null,
			parentReserveTokens: null,
			maxInputChars: 20,
		});
	});
	test("rejects invalid options and model specifications", async () => {
		for (const invalid of [
			{},
			{ packProviderId: "bad/id", packs: {} },
			{ packProviderId: "p", maxConcurrency: 0, packs: {} },
			{ packProviderId: "p", packs: { x: { models: ["missing-provider"] } } },
			{
				packProviderId: "p",
				consensus: { systemPrompt: "" },
				packs: { x: { models: ["p/A*"] } },
			},
			{
				packProviderId: "p",
				consensus: { systemPrompt: "   \n\t  " },
				packs: { x: { models: ["p/A*"] } },
			},
			{
				packProviderId: "p",
				consensus: { systemPrompt: undefined },
				packs: { x: { models: ["p/A*"] } },
			},
			{
				packProviderId: "p",
				consensus: { systemPrompt: 123 },
				packs: { x: { models: ["p/A*"] } },
			},
		]) {
			expect(
				await Effect.runPromise(decodeConfig(invalid).pipe(Effect.result)),
			).toMatchObject({ _tag: "Failure" });
		}
		expect(() => parseModelSpec("p/A#")).toThrow();
	});
	test("matches case exactly, preserves duplicates and enforces cap", async () => {
		const h = harness({
			packs: { x: { models: ["p/a*", "p/A*#high", "p/A*", "p/B"] } },
		});
		const config = await Effect.runPromise(decodeConfig(h.ctx.options));
		const pack = config.packs.x;
		if (!pack) throw new Error("Missing test pack");
		const workers = await Effect.runPromise(
			resolvePackWorkers(h.ctx, pack, 2, "packs"),
		);
		expect(workers.map((w) => w.modelID)).toEqual(["A*", "A*"]);
		expect(workers[0]?.useHookEffort).toBe(true);
		expect(workers[1]?.workerId).toBe("worker-2");
	});
	test("fair quotas redistribute unused budget and include markers within the cap", () => {
		const result = fairTruncate(
			["short", "x".repeat(100), "y".repeat(100)],
			65,
		);
		expect(result.map((s) => s.length)).toEqual([5, 30, 30]);
		expect(result[1]).toEndWith("[...truncated]");
		expect(fairTruncate(["abc", "def"], 1).join("").length).toBe(1);
	});
	test("token estimators select model families and fairly enforce token budgets", () => {
		const claude = tokenEstimator("p", "claude-sonnet-5");
		const gpt = tokenEstimator("p", "gpt-5-nano");
		expect(claude.modelName).toStartWith("anthropic/");
		expect(gpt.modelName).toStartWith("openai/");
		const result = fairTruncateTokens(
			["short", "long response ".repeat(100)],
			20,
			gpt.count,
			gpt.truncate,
		);
		expect(result[0]).toBe("short");
		expect(gpt.count(result.join(""))).toBeLessThanOrEqual(20);
		expect(result[1]).toEndWith("[...truncated]");
	});
	test("token quotas terminate when a caller's truncator never shrinks", () => {
		for (const budget of [0, 5]) {
			const requestedBudgets: number[] = [];
			const result = fairTruncateTokens(
				["abcdef"],
				budget,
				(text) => text.length,
				(text, maxTokens) => {
					requestedBudgets.push(maxTokens);
					return text;
				},
			);
			expect(result).toEqual([""]);
			expect(requestedBudgets).toEqual(budget === 0 ? [0] : [5, 4, 3, 2, 1, 0]);
		}
	});
	test("complete request estimates include history and tool schemas", () => {
		const estimator = tokenEstimator("p", "gpt-5-nano");
		const base = estimateRequestTokens(estimator, {
			system: [{ type: "text", text: "instructions" }],
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			tools: {},
		});
		const withTool = estimateRequestTokens(estimator, {
			system: [{ type: "text", text: "instructions" }],
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			tools: {
				search: {
					description: "Search files",
					input: { type: "object", properties: { query: { type: "string" } } },
				},
			},
		});
		expect(withTool).toBeGreaterThan(base);
	});
	test("profile confidence distinguishes exact IDs, family aliases and unsupported families", () => {
		const known = tokenEstimator("adesso-ai-hub", "gpt-5-nano");
		expect(known.confidence).toBe("known-profile");
		expect(known.modelName).toBe("openai/gpt-5-nano");
		expect(
			tokenEstimatorWarning("adesso-ai-hub", "gpt-5-nano", known),
		).toBeUndefined();
		expect(tokenEstimator("p", "claude-sonnet-5").confidence).toBe(
			"family-approximation",
		);
		for (const id of [
			"google/gemma-4-31b-it",
			"nemotron-3-super-120b",
			"unknown",
		]) {
			const estimator = tokenEstimator("gpt-gateway", id);
			expect(estimator.confidence).toBe("unknown-fallback");
			expect(tokenEstimatorWarning("gpt-gateway", id, estimator)).toContain(
				"context fit is not validated",
			);
		}
	});
	test("native effort variants take precedence over hook options", async () => {
		const h = harness();
		const model = Model.Info.default(
			Provider.ID.make("p"),
			Model.ID.make("A*"),
		);
		const variant = Model.Variant.make({ id: Model.VariantID.make("high") });
		Object.assign(h.ctx.model, {
			list: () => Effect.succeed({ data: [{ ...model, variants: [variant] }] }),
		});
		const config = await Effect.runPromise(decodeConfig(h.ctx.options));
		const pack = config.packs.pair;
		if (!pack) throw new Error("Missing test pack");
		const workers = await Effect.runPromise(
			resolvePackWorkers(h.ctx, pack, 16, "packs"),
		);
		expect(workers[0]?.useHookEffort).toBe(false);
	});
});

describe("Phase 1 plugin execution", () => {
	test("rejects unknown packs, empty packs and denied permissions without spawning", async () => {
		for (const scenario of ["unknown", "empty", "denied"]) {
			const h = harness(
				scenario === "empty"
					? { packs: { pair: { models: ["p/missing"] } } }
					: {},
			);
			if (scenario === "denied")
				Object.assign(h.ctx.permission, {
					assert: () => Effect.fail(new ToolError({ message: "Denied" })),
				});
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* setup(h.ctx);
						const result = yield* h
							.execute({
								agent: "worker",
								model: scenario === "unknown" ? "packs/unknown" : "packs/pair",
								prompt: "request",
							})
							.pipe(Effect.result);
						expect(result._tag).toBe("Failure");
						expect(h.sessions.size).toBe(1);
					}),
				),
			);
		}
	});
	test("all-worker failure returns an error with coordinator ID and diagnostics", async () => {
		const h = harness({ packs: { pair: { models: ["p/B"] } } });
		h.setMode("fail");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const result = yield* h
						.execute({ agent: "worker", prompt: "request" })
						.pipe(Effect.result);
					expect(result._tag).toBe("Failure");
					if (result._tag === "Failure")
						expect(String(result.failure)).toContain("All pack workers failed");
					expect(
						[...h.sessions.values()].some((session) =>
							JSON.stringify(session.messages).includes(
								"429 provider rate limit",
							),
						),
					).toBe(true);
				}),
			),
		);
	});
	test("native delegation, bounded workers, effort hook and persisted follow-ups", async () => {
		const h = harness();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					expect(
						(yield* h.execute({
							agent: "worker",
							model: "p/B",
							prompt: "native",
						})).content,
					).toBe("native");
					const first = yield* h.execute({
						agent: "worker",
						model: "packs/pair",
						prompt: "first",
					});
					expect(first.content).toContain("worker-3");
					expect(h.peak()).toBe(2);
					expect(h.seenEfforts).toContain("high");
					const sessionID = first.metadata?.sessionID as string;
					const reloaded = yield* makeGroupManager(h.ctx).getGroup(sessionID);
					expect(reloaded?.workers).toHaveLength(3);
					const count = h.sessions.size;
					const followup = yield* h.execute({ sessionID, prompt: "followup" });
					expect(followup.content).toContain("Answer 6");
					expect(h.sessions.size).toBe(count);
					expect(h.prompts).toEqual([
						"first",
						"first",
						"first",
						"followup",
						"followup",
						"followup",
					]);
					expect(h.audit.every((entry) => !entry.resume)).toBe(true);
				}),
			),
		);
	});
	test("partial failures and timeouts preserve successful outputs", async () => {
		for (const mode of ["fail", "timeout"] as const) {
			const h = harness({ timeoutMs: 30 });
			h.setMode(mode);
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* setup(h.ctx);
						const result = yield* h.execute({
							agent: "worker",
							prompt: "request",
						});
						expect(result.content).toContain(
							mode === "fail" ? "429 provider rate limit" : "timed out",
						);
						expect(result.content).toContain("Answer");
						expect(result.content).not.toContain("duration:");
						expect(result.content).not.toContain("inspection only");
						if (mode === "timeout") expect(h.interrupted).toHaveLength(1);
					}),
				),
			);
		}
	});
	test("consensus returns only summary and falls back on synthesis errors", async () => {
		for (const fail of [false, true]) {
			const h = harness({
				consensus: {
					enabled: true,
					systemPrompt: "Custom synthesis instructions.",
				},
			});
			if (fail) h.failSynthesis();
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* setup(h.ctx);
						const result = yield* h.execute({
							agent: "worker",
							prompt: "request",
						});
						expect(result.content).toContain(
							fail ? "Warning: consensus" : "Synthesized answer",
						);
						expect(h.synthesisPrompts[0]).toStartWith(
							"Custom synthesis instructions.\n",
						);
						expect(h.synthesisPrompts[0]).not.toContain(
							CONSENSUS_SYSTEM_PROMPT,
						);
						if (!fail) expect(result.content).not.toContain("Answer");
					}),
				),
			);
		}
	});
	test("background returns group ID immediately and notifies parent", async () => {
		const h = harness();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const result = yield* h.execute({
						agent: "worker",
						prompt: "request",
						background: true,
					});
					expect(result.content).toContain("running in background");
					expect(
						h.audit.filter((a) => a.sessionID === "ses_parent"),
					).toHaveLength(0);
					yield* Effect.sleep(40);
					expect(
						h.audit.find((a) => a.sessionID === "ses_parent")?.text,
					).toContain("Answer");
				}),
			),
		);
	});
	test("parent cancellation interrupts running native workers", async () => {
		const h = harness();
		h.setMode("timeout");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const fiber = yield* h
						.execute({ agent: "worker", prompt: "request" })
						.pipe(Effect.forkChild);
					yield* Effect.sleep(10);
					yield* Fiber.interrupt(fiber);
					expect(h.interrupted.length).toBeGreaterThan(0);
				}),
			),
		);
	});
});
