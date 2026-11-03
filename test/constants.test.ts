import { expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeConfig } from "../src/config.ts";
import { DEFAULT_CONSENSUS } from "../src/constants.ts";

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
				timeoutMs: 120_000,
				maxInputChars: 60_000,
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
			consensus: { enabled: true, model: "p/synthesis", timeoutMs: 800 },
			packs: {
				inherited: { models: ["p/a"] },
				overridden: {
					models: ["p/b"],
					maxConcurrency: 1,
					timeoutMs: 200,
					enableInterAgentMessaging: true,
					consensus: { enabled: false, model: null, maxInputChars: 50 },
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
			timeoutMs: 800,
			maxInputChars: 60_000,
		},
	});
	expect(config.packs.overridden).toMatchObject({
		maxConcurrency: 1,
		timeoutMs: 200,
		enableInterAgentMessaging: true,
		consensus: {
			enabled: false,
			model: null,
			timeoutMs: 800,
			maxInputChars: 50,
		},
	});
	expect(Object.isFrozen(DEFAULT_CONSENSUS)).toBe(true);
	expect(DEFAULT_CONSENSUS).toEqual({
		enabled: false,
		model: null,
		timeoutMs: 120_000,
		maxInputChars: 60_000,
	});
});
