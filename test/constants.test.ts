import { expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeConfig } from "../src/config.ts";
import {
	CONSENSUS_SYSTEM_PROMPT,
	DEFAULT_CONSENSUS,
} from "../src/constants.ts";

test("configuration preserves documented defaults for every pack", async () => {
	const config = await Effect.runPromise(
		decodeConfig({
			packProviderId: "packs",
			packs: { first: { models: ["p/a"] }, second: { models: ["p/b"] } },
		}),
	);
	expect(config.maxWorkersPerRun).toBe(16);
	for (const pack of Object.values(config.packs)) {
		expect(pack).toMatchObject({
			maxConcurrency: 2,
			timeoutMs: 120_000,
			enableInterAgentMessaging: false,
			consensus: {
				enabled: false,
				model: null,
				systemPrompt: CONSENSUS_SYSTEM_PROMPT,
				timeoutMs: 120_000,
				maxInputTokens: null,
				maxInputChars: null,
			},
		});
	}
});

test("pack overrides win without changing global settings or shared defaults", async () => {
	const config = await Effect.runPromise(
		decodeConfig({
			packProviderId: "packs",
			maxConcurrency: 3,
			timeoutMs: 500,
			maxWorkersPerRun: 7,
			consensus: {
				enabled: true,
				model: "p/synthesis",
				systemPrompt: "Global consensus prompt",
				timeoutMs: 800,
			},
			packs: {
				inherited: { models: ["p/a"] },
				overridden: {
					models: ["p/b"],
					maxConcurrency: 1,
					timeoutMs: 200,
					enableInterAgentMessaging: true,
					consensus: {
						enabled: false,
						model: null,
						systemPrompt: "Pack consensus prompt",
						maxInputChars: 50,
					},
				},
				resetPrompt: {
					models: ["p/c"],
					consensus: { systemPrompt: null },
				},
			},
		}),
	);
	expect(config.maxWorkersPerRun).toBe(7);
	expect(config.packs.inherited).toMatchObject({
		maxConcurrency: 3,
		timeoutMs: 500,
		consensus: {
			enabled: true,
			model: { provider: "p", model: "synthesis" },
			systemPrompt: "Global consensus prompt",
			timeoutMs: 800,
			maxInputTokens: null,
			maxInputChars: null,
		},
	});
	expect(config.packs.overridden).toMatchObject({
		maxConcurrency: 1,
		timeoutMs: 200,
		enableInterAgentMessaging: true,
		consensus: {
			enabled: false,
			model: null,
			systemPrompt: "Pack consensus prompt",
			timeoutMs: 800,
			maxInputTokens: null,
			maxInputChars: 50,
		},
	});
	expect(config.packs.resetPrompt?.consensus.systemPrompt).toBe(
		CONSENSUS_SYSTEM_PROMPT,
	);
	expect(Object.isFrozen(DEFAULT_CONSENSUS)).toBe(true);
	expect(DEFAULT_CONSENSUS).toEqual({
		enabled: false,
		model: null,
		systemPrompt: CONSENSUS_SYSTEM_PROMPT,
		timeoutMs: 120_000,
		maxInputToken: "25%",
		maxResultToken: "25%",
		maxInputTokens: null,
		maxInputPercentage: 25,
		maxResultPercentage: 25,
		maxResultTokens: null,
		parentReserveTokens: null,
		maxInputChars: null,
	});
});
