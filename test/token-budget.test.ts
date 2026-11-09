import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { setup } from "../src";
import { decodeConfig, TokenLimitSchema } from "../src/config.ts";
import { fairTruncateTokens } from "../src/consensus.ts";
import { parentResultBudget } from "../src/parent-budget.ts";
import {
	limitResultText,
	percentageTokenBudget,
	resolveTokenLimit,
	tokenEstimator,
} from "../src/token-budget.ts";
import { harness } from "./phase-one.test.ts";

test("percentage budgets honor independent capacity and absolute ceilings", () => {
	expect(percentageTokenBudget(1000, 25, 8000)).toBe(250);
	expect(percentageTokenBudget(100000, 25, 8000)).toBe(8000);
	expect(percentageTokenBudget(-100, 25, 8000)).toBe(0);
});

test("dual token settings validate units and resolve absolute and relative budgets", () => {
	const decode = Schema.decodeUnknownSync(TokenLimitSchema);
	for (const value of [1000, "25%", "12.5%", "100%"])
		expect(decode(value)).toBe(value);
	for (const value of [0, -1, 1.5, "25", "0%", "101%", "-5%", "NaN%", null])
		expect(() => decode(value)).toThrow();
	expect(resolveTokenLimit(10000, 1200)).toBe(1200);
	expect(resolveTokenLimit(10000, "25%")).toBe(2500);
	expect(resolveTokenLimit(500, 1200)).toBe(500);
	expect(resolveTokenLimit(-100, "25%")).toBe(0);
	expect(resolveTokenLimit(999, "12.5%")).toBe(124);
});

test("token limits reject non-finite requests when called without schema validation", () => {
	for (const limit of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		"NaN%",
		"Infinity%",
	])
		expect(resolveTokenLimit(10000, limit)).toBe(0);
});

test("dual settings normalize aliases per scope and prefer new names in the same scope", async () => {
	const config = await Effect.runPromise(
		decodeConfig({
			packProviderId: "packs",
			consensus: { maxInputToken: 4000, maxResultToken: "40%" },
			packs: {
				x: {
					models: ["p/B"],
					consensus: {
						maxInputPercentage: 10,
						maxResultToken: 300,
						maxResultPercentage: 90,
					},
				},
				y: { models: ["p/B"] },
			},
		}),
	);
	expect(config.packs.x?.consensus.maxInputToken).toBe("10%");
	expect(config.packs.x?.consensus.maxResultToken).toBe(300);
	expect(config.packs.y?.consensus.maxInputToken).toBe(4000);
	expect(config.packs.y?.consensus.maxResultToken).toBe("40%");
});

test("automatic budgets have no hidden absolute ceilings; explicit legacy overrides inherit", async () => {
	const h = harness();
	const config = await Effect.runPromise(decodeConfig(h.ctx.options));
	const settings = config.packs.pair?.consensus;
	if (!settings) throw new Error("Missing settings");
	expect(settings.maxInputTokens).toBeNull();
	expect(settings.maxInputChars).toBeNull();
	expect(settings.maxResultTokens).toBeNull();
	expect(settings.parentReserveTokens).toBeNull();
	const budget = await Effect.runPromise(
		parentResultBudget(h.ctx, "ses_parent", settings),
	);
	expect(budget.tokens).toBeGreaterThan(8000);
	const legacy = await Effect.runPromise(
		decodeConfig({
			packProviderId: "packs",
			consensus: {
				maxInputTokens: 1200,
				maxResultTokens: 200,
				parentReserveTokens: 100,
				maxInputChars: 3000,
			},
			packs: { x: { models: ["p/B"] } },
		}),
	);
	expect(legacy.packs.x?.consensus).toMatchObject({
		maxInputTokens: 1200,
		maxResultTokens: 200,
		parentReserveTokens: 100,
		maxInputChars: 3000,
	});
});

test("result limiting includes the marker in the parent-token quota", () => {
	const estimator = tokenEstimator("openai", "gpt-5-nano");
	const result = limitResultText(
		"long worker report ".repeat(1000),
		100,
		estimator,
		"ses_group",
	);
	expect(estimator.count(result)).toBeLessThanOrEqual(100);
	expect(result).toContain("Result truncated to parent budget");
	expect(result).toContain("ses_group");
});

test("parent headroom independently limits results and reserves continuation space", async () => {
	const h = harness();
	const config = await Effect.runPromise(decodeConfig(h.ctx.options));
	const settings = config.packs.pair?.consensus;
	if (!settings) throw new Error("Missing test settings");
	const full = await Effect.runPromise(
		parentResultBudget(h.ctx, "ses_parent", settings),
	);
	const ref = h.sessions.get("ses_parent")?.model;
	if (!ref) throw new Error("Missing parent model");
	const empty = await Effect.runPromise(
		parentResultBudget(h.ctx, "ses_parent", settings, {
			model: ref,
			tokens: 1_000_000,
		}),
	);
	expect(full.tokens).toBeGreaterThan(0);
	expect(empty.tokens).toBe(0);
});

test("matching parent snapshots do not count unchanged nonempty history twice", async () => {
	const h = harness();
	const parent = h.sessions.get("ses_parent");
	if (!parent?.model) throw new Error("Missing parent model");
	parent.messages.push({
		id: "history",
		type: "assistant",
		content: [{ type: "text", text: "existing history ".repeat(500) }],
	});
	const config = await Effect.runPromise(decodeConfig(h.ctx.options));
	const settings = config.packs.pair?.consensus;
	if (!settings) throw new Error("Missing settings");
	const estimator = tokenEstimator(parent.model.providerID, parent.model.id);
	const historyTokens = estimator.count(JSON.stringify(parent.messages));
	const withBaseline = await Effect.runPromise(
		parentResultBudget(h.ctx, "ses_parent", settings, {
			model: parent.model,
			tokens: historyTokens + 100,
			historyTokens,
		}),
	);
	const equivalentLegacy = await Effect.runPromise(
		parentResultBudget(h.ctx, "ses_parent", settings, {
			model: parent.model,
			tokens: historyTokens + 100,
		}),
	);
	expect(withBaseline.tokens).toBe(equivalentLegacy.tokens);
});

test("parent context snapshots compare stored history, not lowered outbound messages", async () => {
	const h = harness({ consensus: { enabled: false } });
	const parent = h.sessions.get("ses_parent");
	if (!parent?.model) throw new Error("Missing parent model");
	const model = parent.model;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* setup(h.ctx);
				// The first pack call enrolls this parent for outbound snapshots.
				yield* h.execute({
					agent: "worker",
					model: "packs/pair",
					prompt: "task",
				});
				parent.messages.push({
					id: "stored-history",
					type: "assistant",
					content: [{ type: "text", text: "existing answer" }],
					metadata: { execution: "verbose stored metadata ".repeat(100_000) },
				});
				const event = {
					sessionID: "ses_parent",
					model,
					options: {},
					system: [{ type: "text", text: "instructions" }],
					messages: [{ role: "assistant", content: "existing answer" }],
					tools: {},
				};
				for (const hook of h.hooks) yield* hook(event);
				const unchanged = yield* h.execute({
					agent: "worker",
					model: "packs/pair",
					prompt: "unchanged history",
				});
				expect(unchanged.content).toContain("Answer");
				expect(unchanged.content).not.toContain("insufficient result capacity");

				// Growth after the snapshot must still consume parent headroom.
				parent.messages.push({
					id: "new-history",
					type: "user",
					content: [{ type: "text", text: "new history ".repeat(100_000) }],
				});
				const grown = yield* h.execute({
					agent: "worker",
					model: "packs/pair",
					prompt: "grown history",
				});
				expect(grown.content).toContain("insufficient result capacity");
			}),
		),
	);
});

test("token truncation always fits quotas after decoded-boundary rounding", () => {
	const estimator = tokenEstimator("openai", "gpt-5-nano");
	for (let budget = 0; budget < 100; budget++) {
		const result = estimator.truncate(
			"🙂 mixed unicode evidence ".repeat(100),
			budget,
			"\n[…truncated]",
		);
		expect(estimator.count(result)).toBeLessThanOrEqual(budget);
	}
});

for (const modelID of ["gpt-4.1", "gpt-4-turbo", "gpt-oss-120b"]) {
	test(`${modelID} budgets special-token literals as ordinary text`, () => {
		const estimator = tokenEstimator("openai", modelID);
		const literal = "<|endoftext|> <|fim_prefix|>";
		const text = `${literal} worker evidence `.repeat(100);
		const budget = 100;
		expect(estimator.count(literal)).toBeGreaterThan(0);
		expect(estimator.count(text)).toBeGreaterThan(budget);
		expect(estimator.truncate(literal, budget)).toBe(literal);
		expect(estimator.truncate(text, 0)).toBe("");

		const truncated = estimator.truncate(text, budget, "\n[truncated]");
		expect(truncated).toStartWith(literal);
		expect(truncated).toEndWith("\n[truncated]");
		expect(estimator.count(truncated)).toBeLessThanOrEqual(budget);

		// Exercise both encoding the body and encoding an oversized marker.
		for (const markerBudget of [5, budget]) {
			const result = estimator.truncate(text, markerBudget, literal);
			expect(result.length).toBeGreaterThan(0);
			expect(estimator.count(result)).toBeLessThanOrEqual(markerBudget);
		}

		const evidence = fairTruncateTokens(
			[text, text],
			budget,
			estimator.count,
			estimator.truncate,
		);
		for (const value of evidence) expect(value).toStartWith(literal);
		expect(
			evidence.reduce((sum, value) => sum + estimator.count(value), 0),
		).toBeLessThanOrEqual(budget);

		const report = limitResultText(text, budget, estimator, "ses_group");
		expect(report).toStartWith(literal);
		expect(report).toContain("Result truncated to parent budget");
		expect(estimator.count(report)).toBeLessThanOrEqual(budget);
	});
}

test("percentage configuration rejects invalid ranges", async () => {
	for (const percentage of [0, -1, 101]) {
		const result = await Effect.runPromise(
			decodeConfig({
				packProviderId: "packs",
				consensus: { maxResultPercentage: percentage },
				packs: { x: { models: ["p/B"] } },
			}).pipe(Effect.result),
		);
		expect(result._tag).toBe("Failure");
	}
});

test("direct reports are capped before becoming the coordinator's final answer", async () => {
	const h = harness({ consensus: { enabled: false, maxResultTokens: 100 } });
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { setup } = yield* Effect.promise(
					() => import("../src/index.ts"),
				);
				yield* setup(h.ctx);
				const result = yield* h.execute({
					agent: "worker",
					model: "packs/pair",
					prompt: "task",
				});
				const output = result.output as { output: string };
				expect(
					tokenEstimator("p", "A*").count(output.output),
				).toBeLessThanOrEqual(100);
				expect(output.output).toContain("Result truncated to parent budget");
			}),
		),
	);
});
