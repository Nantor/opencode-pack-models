import { expect, test } from "bun:test";
import { Agent } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { coordinatorFailure } from "../src/coordinator.ts";
import { setup } from "../src/index.ts";
import { harness } from "./phase-one.test.ts";

test("dedicated coordinator is hidden, static and subagent-only without modifying built-in agents", async () => {
	const h = harness();
	for (const id of ["build", "general", "plan"])
		h.agents.set(id, Agent.Info.default(Agent.ID.make(id)));
	const originals = structuredClone([...h.agents.entries()]);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const agent = h.agents.get("packs-coordinator");
				expect(agent).toMatchObject({
					id: "packs-coordinator",
					mode: "subagent",
					hidden: true,
					model: { providerID: "packs-coordinator", id: "static" },
					request: { settings: {}, headers: {}, body: {} },
					permissions: [
						{ action: "*", resource: "*", effect: "deny" },
						{ action: "subagent", resource: "*", effect: "allow" },
					],
				});
				for (const [id, original] of originals)
					expect(h.agents.get(id)).toEqual(original);
			}),
		),
	);
});

test("coordinator agent collision fails without overwriting an existing agent", async () => {
	const h = harness();
	const existing = Agent.Info.default(Agent.ID.make("packs-coordinator"));
	h.agents.set(existing.id, existing);
	const result = await Effect.runPromise(
		Effect.scoped(setup(h.ctx)).pipe(Effect.exit),
	);
	expect(result._tag).toBe("Failure");
	expect(h.agents.get(existing.id)).toEqual(existing);
});

test("missing executable subagent fails immediately instead of looping native calls", async () => {
	const h = harness({ simulateMissingSubagent: true });
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const result = yield* h
					.execute({ agent: "worker", prompt: "Dummy" })
					.pipe(Effect.exit);
				expect(result._tag).toBe("Failure");
				expect(h.prompts).toHaveLength(0);
				expect(h.synthesisCalls()).toBe(0);
				expect(h.interrupted).toHaveLength(1);
			}),
		),
	);
});

test("plan parent never becomes coordinator; off makes zero synthesis calls, on exactly one", async () => {
	for (const enabled of [false, true]) {
		const h = harness({ consensus: { enabled } });
		const parent = h.sessions.get("ses_parent");
		if (!parent) throw new Error("Missing parent");
		Object.assign(parent, { agent: "plan" });
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* setup(h.ctx);
					const result = yield* h.execute({
						agent: "worker",
						prompt: "Original task",
					});
					expect(h.synthesisCalls()).toBe(enabled ? 1 : 0);
					expect(h.prompts).toEqual([
						"Original task",
						"Original task",
						"Original task",
					]);
					const coordinator = h.sessions.get(
						String(result.metadata?.["sessionID"]),
					);
					expect(String(coordinator?.agent)).toBe("packs-coordinator");
					expect(String(parent.agent)).toBe("plan");
					expect(result.content).toContain(
						enabled ? "Synthesized answer" : "worker-3",
					);
				}),
			),
		);
	}
});

test("subagent definition remains stable after worker results, including a nonempty session enum", async () => {
	const h = harness();
	const definitions: unknown[] = [];
	const prompt = h.ctx.session.prompt;
	Object.assign(h.ctx.session, {
		prompt: (input: Parameters<typeof prompt>[0]) =>
			Effect.gen(function* () {
				const isCoordinator =
					(
						h.sessions.get(input.sessionID)?.metadata?.["packModels"] as
							| { role?: string }
							| undefined
					)?.role === "coordinator";
				const capture = Effect.gen(function* () {
					const event = {
						sessionID: input.sessionID,
						options: {},
						tools: {} as Record<
							string,
							{ description: string; input: unknown }
						>,
						system: [],
					};
					for (const hook of h.hooks) yield* hook(event);
					definitions.push(structuredClone(event.tools));
				});
				if (isCoordinator) yield* capture;
				yield* prompt(input);
				if (isCoordinator) yield* capture;
			}),
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				yield* h.execute({ agent: "worker", prompt: "Dummy" });
			}),
		),
	);
	expect(definitions).toHaveLength(2);
	expect(definitions[1]).toEqual(definitions[0]);
	expect(definitions[1]).toMatchObject({
		subagent: {
			input: {
				properties: { sessionID: { enum: ["ses_2", "ses_3", "ses_4"] } },
			},
		},
	});
});

test("coordinator errors include session ID, worker completion and safe provider diagnostics", () => {
	const text = coordinatorFailure(
		{
			groupSessionID: "ses_coordinator",
			workers: [{ status: "succeeded" }, { status: "succeeded" }],
		} as Parameters<typeof coordinatorFailure>[0],
		"failed",
		[
			{
				id: "new",
				type: "assistant",
				error: {
					type: "provider.invalid-request",
					message: "Request rejected",
					response: { body: "private provider payload" },
				},
			},
		] as unknown as Parameters<typeof coordinatorFailure>[2],
		new Set(),
	);
	expect(text).toContain("sessionID: ses_coordinator");
	expect(text).toContain("provider.invalid-request: Request rejected");
	expect(text).toContain("Workers completed: 2/2");
	expect(text).not.toContain("private provider payload");
});

test("parent receives exactly the coordinator's last assistant text and workers are native tool entries", async () => {
	const h = harness({ consensus: { enabled: true } });
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const result = yield* h.execute({ agent: "worker", prompt: "Dummy" });
				const coordinator = h.sessions.get(
					String(result.metadata?.["sessionID"]),
				);
				const last = coordinator?.messages.at(-1) as {
					content: {
						type: string;
						text?: string;
						state?: { metadata?: { sessionID?: string } };
					}[];
				};
				expect((result.output as { output: string }).output).toBe(
					last.content
						.filter((p) => p.type === "text")
						.map((p) => p.text)
						.join("\n"),
				);
				const calls = last.content.filter((p) => p.type === "tool");
				expect(calls).toHaveLength(3);
				for (const call of calls)
					expect(h.sessions.has(String(call.state?.metadata?.sessionID))).toBe(
						true,
					);
				expect(h.audit).toHaveLength(0);
				expect(String(coordinator?.agent)).toBe("packs-coordinator");
				expect(String(coordinator?.model?.providerID)).toBe(
					"packs-coordinator",
				);
			}),
		),
	);
});

test("incomplete scripted turns fail without corrective LLM prompts", async () => {
	const h = harness();
	const prompt = h.ctx.session.prompt;
	let attempts = 0;
	Object.assign(h.ctx.session, {
		prompt: (input: Parameters<typeof prompt>[0]) => {
			const session = h.sessions.get(input.sessionID);
			if (
				(session?.metadata?.["packModels"] as { role?: string } | undefined)
					?.role !== "coordinator"
			)
				return prompt(input);
			return Effect.sync(() => {
				attempts++;
				session?.messages.push({
					id: `premature-${attempts}`,
					type: "assistant",
					content: [{ type: "text", text: "I skipped the workers" }],
				});
			});
		},
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				const result = yield* h
					.execute({ agent: "worker", prompt: "Dummy" })
					.pipe(Effect.result);
				expect(result._tag).toBe("Failure");
				expect(attempts).toBe(1);
				expect(h.prompts).toHaveLength(0);
				expect(h.interrupted).toHaveLength(1);
			}),
		),
	);
});
