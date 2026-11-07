import { Effect, Schema, SchemaGetter } from "effect";
import {
	CONSENSUS_SYSTEM_PROMPT,
	DEFAULT_CONSENSUS,
	DEFAULT_INTER_AGENT_MESSAGING_ENABLED,
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_WORKERS_PER_RUN,
	DEFAULT_WORKER_TIMEOUT_MS,
} from "./constants.ts";

/**
 * Configuration decoding and normalization for the virtual pack provider.
 * The schemas validate user input; the exported config types represent the
 * fully defaulted values consumed by the runner. No provider calls happen here.
 */

// Provider/pack IDs cannot contain model-reference separators or whitespace.
// Model IDs are intentionally less restrictive: punctuation (including `*`)
// is literal and is not interpreted as a wildcard by model resolution.
const Identifier = Schema.String.check(Schema.isPattern(/^[^/#\s]+$/));
const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const NonBlank = Schema.String.check(Schema.isPattern(/\S/));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const Percentage = Schema.Number.check(
	Schema.isGreaterThan(0),
	Schema.isLessThanOrEqualTo(100),
);
/** Numbers are positive integer token counts; strings must explicitly include %. */
export const TokenLimitSchema = Schema.Union([
	PositiveInt,
	Schema.String.check(Schema.isPattern(/^(?:\d+(?:\.\d+)?)%$/)).check(
		Schema.makeFilter(
			(value) =>
				Number(value.slice(0, -1)) > 0 && Number(value.slice(0, -1)) <= 100,
		),
	),
]);
export type TokenLimit = typeof TokenLimitSchema.Type;
export const ModelSpecSchema = Schema.Struct({
	provider: Identifier,
	model: NonEmpty,
	effort: Schema.optionalKey(NonEmpty),
});
export type ModelSpec = typeof ModelSpecSchema.Type;
export const ModelInput = Schema.Union([
	NonEmpty.pipe(
		Schema.decodeTo(ModelSpecSchema, {
			decode: SchemaGetter.transform((input) => {
				// Split at the first slash and last hash. Invalid/empty pieces are
				// rejected by ModelSpecSchema after transformation.
				const slash = input.indexOf("/");
				const hash = input.lastIndexOf("#");
				return {
					provider: slash < 0 ? "" : input.slice(0, slash),
					model:
						slash < 0
							? ""
							: input.slice(slash + 1, hash > slash ? hash : undefined),
					...(hash > slash ? { effort: input.slice(hash + 1) } : {}),
				};
			}),
			encode: SchemaGetter.transform(
				(spec) =>
					`${spec.provider}/${spec.model}${spec.effort ? `#${spec.effort}` : ""}`,
			),
		}),
	),
	ModelSpecSchema,
]);
const ConsensusSchema = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean),
	model: Schema.optionalKey(Schema.Union([ModelInput, Schema.Null])),
	systemPrompt: Schema.optionalKey(Schema.Union([NonBlank, Schema.Null])),
	timeoutMs: Schema.optionalKey(PositiveInt),
	maxInputToken: Schema.optionalKey(TokenLimitSchema),
	maxResultToken: Schema.optionalKey(TokenLimitSchema),
	/** @deprecated Explicit compatibility ceiling; prefer maxInputPercentage. */
	maxInputTokens: Schema.optionalKey(PositiveInt),
	/** @deprecated Use maxInputToken: "25%". */
	maxInputPercentage: Schema.optionalKey(Percentage),
	/** @deprecated Use maxResultToken: "25%". */
	maxResultPercentage: Schema.optionalKey(Percentage),
	/** @deprecated Explicit compatibility ceiling; prefer maxResultPercentage. */
	maxResultTokens: Schema.optionalKey(PositiveInt),
	/** @deprecated Continuation reserve is automatic unless explicitly overridden. */
	parentReserveTokens: Schema.optionalKey(PositiveInt),
	/** @deprecated Explicit compatibility ceiling; prefer maxInputPercentage. */
	maxInputChars: Schema.optionalKey(PositiveInt),
});
const PackSchema = Schema.Struct({
	models: Schema.Array(ModelInput),
	maxConcurrency: Schema.optionalKey(PositiveInt),
	timeoutMs: Schema.optionalKey(PositiveInt),
	enableInterAgentMessaging: Schema.optionalKey(Schema.Boolean),
	consensus: Schema.optionalKey(ConsensusSchema),
});
export const OptionsSchema = Schema.Struct({
	packProviderId: Identifier,
	maxConcurrency: Schema.optionalKey(PositiveInt),
	timeoutMs: Schema.optionalKey(PositiveInt),
	maxWorkersPerRun: Schema.optionalKey(PositiveInt),
	consensus: Schema.optionalKey(ConsensusSchema),
	packs: Schema.Record(Identifier, PackSchema),
});

/** Parse one string or object model reference with the same rules as options. */
export const parseModelSpec = Schema.decodeUnknownSync(ModelInput);

/** Effective synthesis settings after global and per-pack overrides. */
export interface ConsensusConfig {
	enabled: boolean;
	model: ModelSpec | null;
	systemPrompt: string;
	timeoutMs: number;
	/** Absolute evidence tokens or a percentage of consensus input capacity. */
	maxInputToken: TokenLimit;
	/** Absolute parent-result tokens or a percentage of remaining parent capacity. */
	maxResultToken: TokenLimit;
	/** @deprecated Explicit legacy ceiling; null means no absolute ceiling. */
	maxInputTokens: number | null;
	/** @deprecated Retained decoded alias; execution uses maxInputToken. */
	maxInputPercentage: number;
	/** @deprecated Retained decoded alias; execution uses maxResultToken. */
	maxResultPercentage: number;
	/** @deprecated Explicit legacy ceiling; null means no absolute ceiling. */
	maxResultTokens: number | null;
	/** @deprecated Explicit legacy reserve; null selects the automatic policy. */
	parentReserveTokens: number | null;
	/** @deprecated Explicit legacy character ceiling; null disables it. */
	maxInputChars: number | null;
}
/** Effective per-pack limits and the ordered, unexpanded member list. */
export interface PackConfig {
	models: readonly ModelSpec[];
	maxConcurrency: number;
	timeoutMs: number;
	enableInterAgentMessaging: boolean;
	consensus: ConsensusConfig;
}
/** Startup configuration; every pack has explicit defaults at this point. */
export interface Config {
	packProviderId: string;
	maxWorkersPerRun: number;
	packs: Readonly<Record<string, PackConfig>>;
}

/**
 * Decode plugin options once at startup. Global defaults are merged before
 * pack-specific overrides; a pack's `consensus.model: null` explicitly clears
 * the global model, leaving model selection to the parent's session at runtime.
 * Reject references back to the virtual provider to prevent recursive packs.
 */
export const decodeConfig = Effect.fn("decodeConfig")(function* (
	input: unknown,
) {
	const options = yield* Schema.decodeUnknownEffect(OptionsSchema)(input);
	// Warn once during startup, rather than on every worker request or follow-up.
	const legacyKeys = [
		"maxInputTokens",
		"maxInputPercentage",
		"maxResultPercentage",
		"maxResultTokens",
		"parentReserveTokens",
		"maxInputChars",
	] as const;
	for (const settings of [
		options.consensus,
		...Object.values(options.packs).map((pack) => pack.consensus),
	]) {
		if (!settings) continue;
		const supplied = legacyKeys.filter((key) => settings[key] !== undefined);
		if (supplied.length)
			yield* Effect.logWarning(
				`Deprecated consensus budget overrides: ${supplied.join(", ")}. Prefer maxInputToken and maxResultToken; supplied overrides remain honored.`,
			);
	}
	const specs = [
		...Object.values(options.packs).flatMap((pack) => [
			...pack.models,
			...(pack.consensus?.model ? [pack.consensus.model] : []),
		]),
		...(options.consensus?.model ? [options.consensus.model] : []),
	];
	// Validate even disabled consensus references: enabling them later must not
	// turn a pack into an implicit recursive provider invocation.
	if (specs.some((spec) => spec.provider === options.packProviderId))
		return yield* Effect.fail(
			new Error(
				"Pack members and consensus models must not reference the virtual pack provider",
			),
		);
	const global = {
		...DEFAULT_CONSENSUS,
		...options.consensus,
	};
	// Normalize each scope separately so a pack's old alias can override a global
	// new setting. Within one scope the new singular name always takes precedence.
	const limitsFor = (
		settings: typeof options.consensus,
	): Partial<Pick<ConsensusConfig, "maxInputToken" | "maxResultToken">> => ({
		...(settings?.maxInputToken !== undefined
			? { maxInputToken: settings.maxInputToken }
			: settings?.maxInputPercentage !== undefined
				? { maxInputToken: `${settings.maxInputPercentage}%` }
				: settings?.maxInputTokens !== undefined
					? { maxInputToken: settings.maxInputTokens }
					: {}),
		...(settings?.maxResultToken !== undefined
			? { maxResultToken: settings.maxResultToken }
			: settings?.maxResultPercentage !== undefined
				? { maxResultToken: `${settings.maxResultPercentage}%` }
				: settings?.maxResultTokens !== undefined
					? { maxResultToken: settings.maxResultTokens }
					: {}),
	});
	const packs = Object.fromEntries(
		Object.entries(options.packs).map(([id, pack]) => {
			const consensus = {
				...global,
				...limitsFor(options.consensus),
				...pack.consensus,
				...limitsFor(pack.consensus),
			};
			return [
				id,
				{
					models: pack.models,
					maxConcurrency:
						pack.maxConcurrency ??
						options.maxConcurrency ??
						DEFAULT_MAX_CONCURRENCY,
					timeoutMs:
						pack.timeoutMs ?? options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
					enableInterAgentMessaging:
						pack.enableInterAgentMessaging ??
						DEFAULT_INTER_AGENT_MESSAGING_ENABLED,
					consensus: {
						...consensus,
						model: consensus.model ?? null,
						systemPrompt: consensus.systemPrompt ?? CONSENSUS_SYSTEM_PROMPT,
					},
				},
			];
		}),
	);
	return {
		packProviderId: options.packProviderId,
		maxWorkersPerRun: options.maxWorkersPerRun ?? DEFAULT_MAX_WORKERS_PER_RUN,
		packs,
	} satisfies Config;
});
