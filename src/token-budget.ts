import type { SessionContext } from "@opencode/plugin/effect/session";
import { type Encoding, type ModelName, models, Tokenizer } from "ai-tokenizer";
import {
	cl100k_base,
	claude,
	o200k_base,
	p50k_base,
} from "ai-tokenizer/encoding";
import type { TokenLimit } from "./config.ts";

/**
 * Local, approximate token budgeting; no provider calls or credentials required.
 * Family profiles combine a BPE encoding with the package's calibration factors.
 * Neither these profiles nor the safety margin guarantee provider acceptance,
 * especially for unknown models and multimodal inputs.
 */

/** Catalog information needed to select an estimator and enforce input limits. */
export interface TokenModelInfo {
	providerID: string;
	modelID: string;
	limit: { context: number; input?: number | undefined; output: number };
}

const encodings: Record<(typeof models)[ModelName]["encoding"], Encoding> = {
	cl100k_base,
	claude,
	o200k_base,
	p50k_base,
};
type EncodingName = keyof typeof encodings;
// Reuse encoding instances across workers; their merge caches avoid repeated work.
const tokenizers = new Map<EncodingName, Tokenizer>();

/** Reserve room for estimator error and provider-added protocol tokens. */
export const INPUT_TOKEN_SAFETY_RATIO = 0.85;

/**
 * Map gateway aliases to representative package profiles. This is family-based
 * approximation, not a claim that every version shares an identical tokenizer.
 * Keep more specific names before broad family matches (for example gpt-oss).
 */
function inferredModelName(modelID: string): ModelName {
	// Provider names are not tokenizer evidence (a gateway can host many families).
	const value = modelID.toLowerCase();
	if (value.includes("claude")) {
		if (value.includes("haiku")) return "anthropic/claude-haiku-4.5";
		if (value.includes("opus")) return "anthropic/claude-opus-4.5";
		return "anthropic/claude-sonnet-4.5";
	}
	if (value.includes("gpt-oss-120b")) return "openai/gpt-oss-120b";
	if (value.includes("gpt-oss")) return "openai/gpt-oss-20b";
	if (value.includes("codex")) return "openai/gpt-5-codex";
	if (value.includes("gpt")) return "openai/gpt-5";
	if (value.includes("gemini")) return "google/gemini-3-pro-preview";
	if (value.includes("qwen3-coder")) return "alibaba/qwen3-coder";
	if (value.includes("qwen")) return "alibaba/qwen-3-235b";
	if (value.includes("llama")) return "meta/llama-3.3-70b";
	if (value.includes("devstral")) return "mistral/devstral-small";
	if (value.includes("nova")) return "amazon/nova-lite";
	if (value.includes("deepseek")) return "deepseek/deepseek-v3";
	// o200k is a strong general-purpose fallback for modern model families.
	return "openai/gpt-5";
}

/** Profile availability, not a promise of exact provider token counts. */
export type TokenProfileConfidence =
	| "known-profile"
	| "family-approximation"
	| "unknown-fallback";

/** Immutable selection metadata shared by diagnostics and estimator instances. */
export interface TokenProfileSelection {
	/** Packaged profile ID, never an arbitrary provider model reference. */
	readonly modelName: ModelName;
	readonly confidence: TokenProfileConfidence;
	readonly reason: string;
}

/**
 * Prefer a package entry for the exact model ID, including gateway-hosted IDs.
 * Do not normalize versions or gateway prefixes into an exact-profile claim.
 */
function selectTokenProfile(
	providerID: string,
	modelID: string,
): TokenProfileSelection {
	// Object.keys erases literal keys; this assertion is confined to the package catalog.
	const entries = Object.keys(models) as ModelName[];
	const exact = entries.find((name) => name === `${providerID}/${modelID}`);
	const matches = entries.filter(
		(name) => name.slice(name.indexOf("/") + 1) === modelID,
	);
	const known = exact ?? (matches.length === 1 ? matches[0] : undefined);
	if (known)
		return {
			modelName: known,
			confidence: "known-profile",
			reason:
				"The model ID matches a packaged profile; counts remain estimates.",
		};
	const family =
		/claude|gpt|codex|gemini|qwen|llama|devstral|nova|deepseek/i.test(modelID);
	const unsupportedFamily = /gemma/i.test(modelID)
		? "Gemma"
		: /nemotron/i.test(modelID)
			? "Nemotron"
			: undefined;
	return {
		modelName: inferredModelName(modelID),
		confidence: family ? "family-approximation" : "unknown-fallback",
		reason: family
			? "Using a representative family profile, not a verified profile for this version."
			: `${unsupportedFamily ?? "This model"} has no matching packaged profile or supported family mapping.`,
	};
}

/** Text-only estimates and truncation using one consistent calibrated profile. */
export interface TokenEstimator extends TokenProfileSelection {
	/** Estimated content tokens, excluding request/message overhead. */
	count(text: string): number;
	/** Keep a token prefix; a supplied marker consumes part of the same budget. */
	truncate(text: string, maxTokens: number, marker?: string): string;
}

/** Actual host request shapes; excludes transport settings unrelated to token counts. */
export type TokenRequest = Pick<
	SessionContext,
	"system" | "messages" | "tools"
>;

/** Resolve an absolute or percentage limit, always clamping to usable capacity. */
export function resolveTokenLimit(capacity: number, limit: TokenLimit): number {
	const requested =
		typeof limit === "number"
			? limit
			: (capacity * Number(limit.slice(0, -1))) / 100;
	if (!Number.isFinite(requested)) return 0;
	return Math.max(0, Math.floor(Math.min(capacity, requested)));
}

/** Compute a percentage quota with an absolute ceiling; negative headroom is zero. */
export function percentageTokenBudget(
	capacity: number,
	percentage: number,
	absoluteLimit: number,
): number {
	return Math.max(
		0,
		Math.floor(Math.min((capacity * percentage) / 100, absoluteLimit)),
	);
}

/**
 * Limit complete returned text, including diagnostics, with a visible marker.
 * Recount decoded prefixes because Unicode/token boundaries can change counts.
 */
export function limitResultText(
	text: string,
	budget: number,
	estimator: TokenEstimator,
	sessionID: string,
): string {
	if (estimator.count(text) <= budget) return text;
	const marker = `\n[Result truncated to parent budget. Worker transcripts: ${sessionID}]`;
	let quota = Math.max(0, Math.floor(budget));
	let result = estimator.truncate(text, quota, marker);
	while (estimator.count(result) > budget && quota > 0) {
		quota = Math.max(0, quota - Math.max(1, estimator.count(result) - budget));
		result = estimator.truncate(text, quota, marker);
	}
	return result;
}

/** Select the closest calibrated ai-tokenizer model for a catalog model. */
export function tokenEstimator(
	providerID: string,
	modelID: string,
): TokenEstimator {
	const { modelName, confidence, reason } = selectTokenProfile(
		providerID,
		modelID,
	);
	const model = models[modelName];
	const encodingName = model.encoding;
	let tokenizer = tokenizers.get(encodingName);
	if (!tokenizer) {
		tokenizer = new Tokenizer(encodings[encodingName]);
		tokenizers.set(encodingName, tokenizer);
	}
	const multiplier = model.tokens.contentMultiplier;
	// Treat special-token literals in reports as ordinary text in both paths.
	const count = (text: string): number =>
		Math.round(tokenizer.encode(text, [], []).length * multiplier);
	return {
		modelName,
		confidence,
		reason,
		count,
		truncate(text: string, maxTokens: number, marker = ""): string {
			const budget = Math.max(0, Math.floor(maxTokens));
			if (count(text) <= budget) return text;
			if (budget === 0) return "";
			const markerTokens = marker ? count(marker) : 0;
			const encoded = tokenizer.encode(
				markerTokens >= budget ? marker : text,
				[],
				[],
			);
			const suffix = markerTokens >= budget ? "" : marker;
			// Token-boundary merges and calibration rounding make direct slicing
			// approximate. Binary-search decoded prefixes and recount the final text.
			let low = 0;
			let high = encoded.length;
			let result = suffix && count(suffix) <= budget ? suffix : "";
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				const candidate = tokenizer.decode(encoded.slice(0, middle)) + suffix;
				if (count(candidate) <= budget) {
					result = candidate;
					low = middle + 1;
				} else high = middle - 1;
			}
			return result;
		},
	};
}

/** Unknown profiles must never silently appear to provide reliable fit checks. */
export function tokenEstimatorWarning(
	providerID: string,
	modelID: string,
	estimator: TokenEstimator = tokenEstimator(providerID, modelID),
): string | undefined {
	if (estimator.confidence !== "unknown-fallback") return undefined;
	return `Token estimate for ${providerID}/${modelID}: ${estimator.reason} Using ${estimator.modelName} as an unverified heuristic only; context fit is not validated and the safety margin may be insufficient.`;
}

/**
 * Apply the safety margin to the declared input limit. When only a shared
 * context window is known, conservatively reserve the full output allowance.
 */
export function safeInputTokenLimit(model: TokenModelInfo): number {
	const declared =
		model.limit.input ?? Math.max(0, model.limit.context - model.limit.output);
	return Math.floor(declared * INPUT_TOKEN_SAFETY_RATIO);
}

/**
 * Estimate a complete OpenCode model request, including system text, history,
 * tool schemas and protocol/message overhead. JSON serialization deliberately
 * retains metadata because providers may encode it into their wire format.
 * This serialization is a conservative proxy, not the provider's actual chat
 * template or the HTTP request body; transport JSON whitespace is not counted.
 * Media and provider-native replay data are not measured precisely here.
 */
export function estimateRequestTokens(
	estimator: TokenEstimator,
	request: TokenRequest,
): number {
	const model = models[estimator.modelName];
	const config = model.tokens;
	const serialized = (value: unknown): string => JSON.stringify(value) ?? "";
	let total = config.baseOverhead;
	for (const system of request.system)
		total += config.perMessage + estimator.count(serialized(system));
	for (const message of request.messages)
		total += config.perMessage + estimator.count(serialized(message));
	const tools = Object.entries(request.tools);
	if (tools.length) total += config.toolsExist;
	for (const [index, [name, definition]] of tools.entries()) {
		total += estimator.count(name) + estimator.count(serialized(definition));
		if (index > 0) total += config.perTool;
	}
	return total;
}
