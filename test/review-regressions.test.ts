import { expect, test } from "bun:test";
import { Agent, Model, Provider } from "@opencode/plugin/effect";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Cause, Deferred, Effect, Fiber } from "effect";
import { decodeConfig } from "../src/config.ts";
import { setup } from "../src/index.ts";
import { resolveModel, resolvePackWorkers } from "../src/models.ts";
import { harness } from "./phase-one.test.ts";

test("skipped members remain visible with consensus, background replies and persisted follow-ups", async () => {
	for (const background of [false, true]) {
		const h = harness({
			packs: { pair: { models: ["p/missing", "p/B"] } },
			consensus: { enabled: true },
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const result = yield* h.execute({
						agent: "worker",
						prompt: "request",
						background,
					});
					expect(result.content).toContain(
						"Warning: Skipped unavailable model: p/missing",
					);
					const groupID = String(result.metadata?.sessionID);
					expect(h.sessions.get(groupID)?.metadata).toMatchObject({
						packModels: { role: "coordinator" },
					});
					const worker = [...h.sessions.values()].find(
						(s) =>
							s.metadata?.packModels &&
							(s.metadata.packModels as { role?: string }).role === "worker",
					);
					expect(worker?.metadata).toMatchObject({
						packModels: { role: "worker", groupSessionID: groupID },
					});
					if (background) {
						yield* Effect.sleep(30);
						expect(
							h.audit.find((a) => a.sessionID === "ses_parent")?.text,
						).toContain("Warning: Skipped unavailable model: p/missing");
					} else {
						expect(result.content).toContain("Synthesized answer");
						const stored = h.stored.get(`pack_group/${groupID}`);
						expect(stored).toMatchObject({
							warnings: expect.arrayContaining([
								"Skipped unavailable model: p/missing",
							]),
						});
						expect(result.content).toContain("context fit is not validated");
					}
					const followup = yield* h.execute({
						sessionID: groupID,
						prompt: "followup",
					});
					expect(followup.content).toContain(
						"Warning: Skipped unavailable model: p/missing",
					);
					const persisted = h.stored.get(`pack_group/${groupID}`) as {
						warnings: string[];
					};
					expect(
						persisted.warnings.filter((warning) =>
							warning.startsWith("Token estimate for p/B:"),
						),
					).toHaveLength(1);
				}),
			),
		);
	}
});

test("worker cap and all-unavailable errors explain omitted members", async () => {
	for (const models of [["p/B", "p/A*"], ["p/missing"]]) {
		const h = harness({ maxWorkersPerRun: 1, packs: { pair: { models } } });
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const result = yield* h
						.execute({ agent: "worker", prompt: "request" })
						.pipe(Effect.result);
					if (result._tag === "Success")
						expect(result.success.content).toContain(
							"Warning: Worker limit reached (1)",
						);
					else
						expect(result.failure.message).toContain(
							"Skipped unavailable model: p/missing",
						);
				}),
			),
		);
	}
});

test("pack replies satisfy the native subagent structured output contract", async () => {
	for (const background of [false, true]) {
		const h = harness();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const result = yield* h.execute({
						agent: "worker",
						prompt: "Return a dummy answer",
						background,
					});
					expect(result.output).toEqual({
						sessionID: result.metadata?.sessionID,
						status: background ? "running" : "completed",
						output: background
							? result.content
							: (result.output as { output: string }).output,
					});
					expect(result.metadata?.status).toBe(
						background ? "running" : "completed",
					);
				}),
			),
		);
	}
});

test("failed wait stops native workers before releasing permits or accepting follow-ups", async () => {
	const h = harness({ maxConcurrency: 1 });
	const nativeActive = new Set<string>();
	const prompt = h.ctx.session.prompt;
	const interrupt = h.ctx.session.interrupt;
	let peak = 0;
	Object.assign(h.ctx.session, {
		prompt: (input: Parameters<typeof prompt>[0]) =>
			prompt(input).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						expect(nativeActive.has(input.sessionID)).toBe(false);
						nativeActive.add(input.sessionID);
						peak = Math.max(peak, nativeActive.size);
					}),
				),
			),
		wait: () => Effect.fail(new Error("service connection lost")),
		interrupt: (input: Parameters<typeof interrupt>[0]) =>
			Effect.sleep(5).pipe(
				Effect.andThen(
					Effect.sync(() => {
						expect(input.resume).toBe(false);
						nativeActive.delete(input.sessionID);
					}),
				),
				Effect.andThen(interrupt(input)),
			),
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const first = yield* h
					.execute({ agent: "worker", prompt: "first" })
					.pipe(Effect.result);
				expect(first._tag).toBe("Failure");
				if (first._tag === "Failure")
					expect(first.failure.message).toContain("service connection lost");
				expect(nativeActive.size).toBe(0);
				const groupID = [...h.stored.keys()]
					.find((key) => key.startsWith("pack_group/"))
					?.slice("pack_group/".length);
				if (!groupID) throw new Error("Missing group");
				yield* h
					.execute({ sessionID: groupID, prompt: "followup" })
					.pipe(Effect.result);
				expect(nativeActive.size).toBe(0);
				expect(h.interrupted).toHaveLength(8);
				expect(peak).toBeLessThanOrEqual(2);
			}),
		),
	);
});

test("cleanup failure preserves the worker's original API error", async () => {
	const h = harness({ packs: { pair: { models: ["p/B"] } } });
	let attempts = 0;
	Object.assign(h.ctx.session, {
		wait: () => Effect.fail(new Error("original wait failure")),
		interrupt: () =>
			Effect.sync(() => {
				attempts++;
			}).pipe(Effect.andThen(Effect.fail(new Error("cleanup failure")))),
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const result = yield* h
					.execute({ agent: "worker", prompt: "request" })
					.pipe(Effect.result);
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure") {
					expect(result.failure.message).toContain("original wait failure");
					expect(result.failure.message).not.toContain("cleanup failure");
				}
				expect(attempts).toBe(2);
			}),
		),
	);
});

test("failed prompt acknowledgement also stops a potentially admitted native session", async () => {
	const h = harness({ packs: { pair: { models: ["p/B"] } } });
	const prompt = h.ctx.session.prompt;
	Object.assign(h.ctx.session, {
		prompt: (input: Parameters<typeof prompt>[0]) =>
			prompt(input).pipe(
				Effect.andThen(Effect.fail(new Error("acknowledgement lost"))),
			),
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				expect(
					(yield* h
						.execute({ agent: "worker", prompt: "request" })
						.pipe(Effect.result))._tag,
				).toBe("Failure");
				expect(h.interrupted).toHaveLength(2);
			}),
		),
	);
});

test("empty worker answers cannot reuse intermediate narration", async () => {
	for (const finalText of ["", "   ", "Actual final answer"]) {
		const h = harness({
			packs: { pair: { models: ["p/B"] } },
			consensus: { enabled: true },
		});
		let consensusCalls = 0;
		Object.assign(h.ctx.experimental.generate, {
			text: () =>
				Effect.sync(() => {
					consensusCalls++;
					return { text: "summary" };
				}),
		});
		Object.assign(h.ctx.session, {
			wait: ({ sessionID }: { sessionID: string }) =>
				Effect.sync(() => {
					const session = h.sessions.get(sessionID);
					if (!session) throw new Error("Missing worker");
					if (
						(session.metadata?.packModels as { role?: string } | undefined)
							?.role === "coordinator"
					)
						return;
					session.outcome = "succeeded";
					session.messages.push(
						{
							id: "intermediate",
							type: "assistant",
							content: [
								{ type: "text", text: "I will inspect the files now." },
								{ type: "tool" },
							],
						},
						{
							id: "final",
							type: "assistant",
							content: [{ type: "text", text: finalText }],
						},
					);
				}),
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const result = yield* h
						.execute({ agent: "worker", prompt: "request" })
						.pipe(Effect.result);
					expect(result._tag).toBe(finalText.trim() ? "Success" : "Failure");
					if (result._tag === "Failure") {
						expect(result.failure.message).toContain(
							"Worker produced no final assistant response",
						);
						expect(result.failure.message).not.toContain("I will inspect");
					}
					expect(consensusCalls).toBe(finalText.trim() ? 1 : 0);
				}),
			),
		);
	}
});

test("virtual pack references fail configuration, including unused global consensus", async () => {
	for (const options of [
		{ packs: { pair: { models: ["packs/pair"] } } },
		{ consensus: { model: "packs/pair" } },
		{
			packs: { pair: { models: ["p/B"], consensus: { model: "packs/pair" } } },
		},
	]) {
		const h = harness(options);
		expect(
			(await Effect.runPromise(decodeConfig(h.ctx.options).pipe(Effect.result)))
				._tag,
		).toBe("Failure");
	}
});

test("worker resolution uses one catalog snapshot and refuses virtual models at runtime", async () => {
	const h = harness();
	const config = await Effect.runPromise(decodeConfig(h.ctx.options));
	const pack = config.packs.pair;
	if (!pack) throw new Error("Missing pack");
	let calls = 0;
	const list = h.ctx.model.list;
	Object.assign(h.ctx.model, {
		list: () => {
			calls++;
			return list();
		},
	});
	await Effect.runPromise(
		resolvePackWorkers(h.ctx, pack, 16, config.packProviderId),
	);
	expect(calls).toBe(1);
	expect(
		(
			await Effect.runPromise(
				resolveModel(h.ctx, { provider: "packs", model: "pair" }, "packs").pipe(
					Effect.result,
				),
			)
		)._tag,
	).toBe("Failure");
});

test("worker timeouts remain visible and interrupts explicitly disable resume", async () => {
	const h = harness({
		consensus: { enabled: true, timeoutMs: 10 },
		timeoutMs: 15,
	});
	h.setMode("timeout");
	const resumes: unknown[] = [];
	const interrupt = h.ctx.session.interrupt;
	Object.assign(h.ctx.session, {
		interrupt: (input: Parameters<typeof interrupt>[0]) => {
			resumes.push(input.resume);
			return interrupt(input);
		},
	});
	Object.assign(h.ctx.experimental.generate, { text: () => Effect.never });
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const output = yield* h.execute({ agent: "worker", prompt: "request" });
				expect(output.content).toContain("Warning: consensus");
			}),
		),
	);
	expect(resumes).toEqual([false]);
});

test("invalid and worker follow-ups never spawn or delegate; conflicts are rejected", async () => {
	const h = harness();
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const first = yield* h.execute({
					agent: "worker",
					model: "packs/pair",
					prompt: "first",
				});
				const groupID = first.metadata?.sessionID;
				const workerID = [...h.sessions.keys()].find(
					(id) => id !== "ses_parent" && id !== groupID,
				);
				const size = h.sessions.size;
				for (const input of [
					{ sessionID: "ses_typo", model: "packs/pair" },
					{ sessionID: "ses_typo", agent: "worker" },
					{ sessionID: workerID, model: "packs/pair" },
					{ sessionID: workerID, agent: "worker" },
					{ sessionID: groupID, model: "p/B" },
					{ sessionID: groupID, agent: "different" },
				]) {
					const result = yield* h
						.execute({ ...input, prompt: "followup" })
						.pipe(Effect.result);
					expect(result._tag).toBe("Failure");
					if (result._tag === "Failure" && input.sessionID === workerID)
						expect(result.failure.message).toContain(String(groupID));
					expect(h.sessions.size).toBe(size);
				}
				expect(h.prompts).toHaveLength(3);
			}),
		),
	);
});

test("host ToolError identity, metadata and underlying error survive permission rejection", async () => {
	const h = harness();
	const error = new ToolError({
		message: "Denied",
		metadata: { reason: "policy" },
		error: new Error("detail"),
	});
	Object.assign(h.ctx.permission, { assert: () => Effect.fail(error) });
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const result = yield* h
					.execute({ agent: "worker", prompt: "request" })
					.pipe(Effect.result);
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure") expect(result.failure).toBe(error);
			}),
		),
	);
});

test("coordinator inherits parent agent then workspace model and rejects virtual parent models", async () => {
	for (const source of ["agent", "default", "virtual"]) {
		const h = harness({ consensus: { enabled: true } });
		const parent = h.sessions.get("ses_parent");
		if (!parent) throw new Error("Missing parent");
		Object.assign(parent, { model: undefined });
		if (source === "agent") {
			Object.assign(parent, { agent: Agent.ID.make("parent-agent") });
			Object.assign(h.ctx.agent, {
				get: () =>
					Effect.succeed({
						data: {
							mode: "subagent",
							model: {
								providerID: Provider.ID.make("p"),
								id: Model.ID.make("B"),
							},
						},
					}),
			});
		}
		if (source === "virtual")
			parent.model = {
				providerID: Provider.ID.make("packs"),
				id: Model.ID.make("pair"),
			};
		if (source === "default") {
			const get = h.ctx.agent.get;
			Object.assign(h.ctx.agent, {
				get: (input: Parameters<typeof get>[0]) =>
					input.agentID === "build"
						? Effect.succeed({ data: { mode: "primary" } })
						: get(input),
			});
		}
		let calls = 0;
		Object.assign(h.ctx.experimental.generate, {
			text: () =>
				Effect.sync(() => {
					calls++;
					return { text: "summary" };
				}),
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const result = yield* h
						.execute({
							agent: "worker",
							model: "packs/pair",
							prompt: "request",
						})
						.pipe(Effect.result);
					expect(result._tag).toBe("Success");
					if (result._tag === "Success")
						expect(result.success.content).toContain(
							source === "virtual" ? "Warning: consensus" : "summary",
						);
					expect(calls).toBe(source === "virtual" ? 0 : 1);
				}),
			),
		);
	}
});

test("cancellation during the coordinator final turn propagates without parent notification", async () => {
	for (const background of [false, true]) {
		const h = harness({ consensus: { enabled: true } });
		const started = Deferred.makeUnsafe<void>();
		const prompt = h.ctx.session.prompt;
		Object.assign(h.ctx.session, {
			prompt: (input: Parameters<typeof prompt>[0]) =>
				prompt(input).pipe(
					Effect.andThen(
						(
							h.sessions.get(input.sessionID)?.metadata?.packModels as
								| { role?: string }
								| undefined
						)?.role === "coordinator"
							? Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
								)
							: Effect.void,
					),
				),
		});
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					if (background) {
						yield* h.execute({
							agent: "worker",
							prompt: "request",
							background: true,
						});
						yield* Deferred.await(started);
					} else {
						const fiber = yield* h
							.execute({ agent: "worker", prompt: "request" })
							.pipe(Effect.forkChild);
						yield* Deferred.await(started);
						yield* Fiber.interrupt(fiber);
						const workerExit = yield* Fiber.await(fiber);
						expect(workerExit._tag).toBe("Failure");
						if (workerExit._tag === "Failure")
							expect(Cause.hasInterrupts(workerExit.cause)).toBe(true);
					}
				}),
			),
		);
		expect(exit._tag).toBe("Success");
		expect(
			h.audit.some(
				(a) =>
					a.text.includes("Warning: consensus") || a.sessionID === "ses_parent",
			),
		).toBe(false);
	}
});

test("plugin shutdown during background workers sends no bogus completion", async () => {
	const h = harness();
	h.setMode("timeout");
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				yield* h.execute({
					agent: "worker",
					prompt: "request",
					background: true,
				});
				yield* Effect.sleep(10);
			}),
		),
	);
	expect(h.interrupted.length).toBeGreaterThan(0);
	expect(h.audit.some((a) => a.sessionID === "ses_parent")).toBe(false);
});

test("failed and interrupted worker creation clean up sessions and never publish partial groups", async () => {
	for (const interrupt of [false, true]) {
		const h = harness();
		const create = h.ctx.session.create;
		const blocked = Deferred.makeUnsafe<void>();
		let calls = 0;
		Object.assign(h.ctx.session, {
			create: (input: Parameters<typeof create>[0]) => {
				calls++;
				if (calls === 3 && !interrupt)
					return Effect.fail(new Error("creation failed"));
				return create(input).pipe(
					Effect.tap(() =>
						calls === 2 && interrupt
							? Deferred.succeed(blocked, undefined).pipe(
									Effect.andThen(Effect.sleep(20)),
								)
							: Effect.void,
					),
				);
			},
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					if (interrupt) {
						const fiber = yield* h
							.execute({ agent: "worker", prompt: "request" })
							.pipe(Effect.forkChild);
						yield* Deferred.await(blocked);
						yield* Fiber.interrupt(fiber);
					} else
						expect(
							(yield* h
								.execute({ agent: "worker", prompt: "request" })
								.pipe(Effect.result))._tag,
						).toBe("Failure");
				}),
			),
		);
		expect(h.sessions.size).toBe(1);
		expect(h.stored.size).toBe(0);
	}
});

test("worker outcome diagnostics include provider error and messaging configuration is retained", async () => {
	const h = harness({
		packs: {
			pair: { models: ["p/B", "p/A*"], enableInterAgentMessaging: true },
		},
	});
	h.setMode("fail");
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const result = yield* h.execute({ agent: "worker", prompt: "request" });
				expect(result.content).toContain("429 provider rate limit");
				const stored = h.stored.get(
					`pack_group/${result.metadata?.sessionID}`,
				) as { enableInterAgentMessaging: boolean };
				expect(stored.enableInterAgentMessaging).toBe(true);
			}),
		),
	);
});

test("failed legacy catalog recovery releases a follow-up reservation", async () => {
	const h = harness();
	const groupID = "ses_existing";
	const workerID = "ses_worker";
	h.sessions.set(groupID, {
		id: groupID as never,
		messages: [],
		metadata: { packModels: { role: "coordinator", packId: "pair" } },
	});
	h.sessions.set(workerID, {
		id: workerID as never,
		messages: [],
		metadata: { packModels: { role: "worker", groupSessionID: groupID } },
	});
	h.stored.set(`pack_group/${groupID}`, {
		groupSessionID: groupID,
		packId: "pair",
		agentId: "worker",
		parentSessionID: "ses_parent",
		enableInterAgentMessaging: false,
		workers: [
			{
				workerId: "worker-1",
				label: "worker-1 (p/B)",
				providerID: "p",
				modelID: "B",
				useHookEffort: false,
				sessionID: workerID,
				status: "pending",
			},
		],
		createdAt: 0,
	});
	h.stored.set(`pack_worker/${workerID}`, groupID);
	const list = h.ctx.model.list;
	let failLookup = true;
	Object.assign(h.ctx.model, {
		list: () =>
			failLookup ? Effect.fail(new Error("catalog unavailable")) : list(),
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const failed = yield* h
					.execute({ sessionID: groupID, prompt: "first" })
					.pipe(Effect.result);
				expect(failed._tag).toBe("Failure");
				failLookup = false;
				const retry = yield* h.execute({ sessionID: groupID, prompt: "retry" });
				expect(retry.content).not.toContain("already has an active run");
				Object.assign(h.ctx.model, { list: () => Effect.never });
				const interruptedLookup = yield* h
					.execute({ sessionID: groupID, prompt: "cancelled lookup" })
					.pipe(Effect.forkChild);
				yield* Effect.sleep(5);
				yield* Fiber.interrupt(interruptedLookup);
				Object.assign(h.ctx.model, { list });
				const afterCancellation = yield* h.execute({
					sessionID: groupID,
					prompt: "after cancellation",
				});
				expect(afterCancellation.content).not.toContain(
					"already has an active run",
				);
			}),
		),
	);
});

test("zero-capacity workers are admitted to preflight and rejected", async () => {
	const h = harness({ packs: { pair: { models: ["p/B"] } } });
	const list = h.ctx.model.list;
	Object.assign(h.ctx.model, {
		list: () =>
			list().pipe(
				Effect.map(({ data }) => ({
					data: data.map((model) =>
						model.providerID === "p" && model.id === "B"
							? { ...model, limit: { ...model.limit, input: 0 } }
							: model,
					),
				})),
			),
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const result = yield* h
					.execute({ agent: "worker", prompt: "request" })
					.pipe(Effect.exit);
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure")
					expect(Cause.pretty(result.cause)).toContain(
						"Estimated worker input",
					);
				expect(h.interrupted.length).toBeGreaterThan(0);
			}),
		),
	);
});

test("insufficient parent headroom still completes foreground and background runs", async () => {
	for (const background of [false, true]) {
		const h = harness({
			packs: {
				pair: {
					models: ["p/B"],
					consensus: { enabled: false, parentReserveTokens: 1_000_000 },
				},
			},
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const result = yield* h.execute({
						agent: "worker",
						prompt: "request",
						background,
					});
					if (background) {
						yield* Effect.sleep(30);
						const notice = h.audit.find(
							(entry) => entry.sessionID === "ses_parent",
						);
						expect(notice?.resume).toBe(true);
						expect(notice?.text).toContain("insufficient result capacity");
					} else
						expect(result.content).toContain("insufficient result capacity");
				}),
			),
		);
	}
});
