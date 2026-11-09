import type { Model, Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import type { ConsensusConfig } from "./config.ts";
import { SessionID } from "./session-id.ts";
import {
	resolveTokenLimit,
	safeInputTokenLimit,
	type TokenEstimator,
	tokenEstimator,
} from "./token-budget.ts";

/** Last actual outbound parent request; a snapshot is not a concurrency reservation. */
export interface ParentContextSnapshot {
	readonly model: Model.Ref;
	readonly tokens: number;
	/** Stored context() history at snapshot time, measured with the same estimator. */
	readonly historyTokens?: number;
}

export interface ParentResultBudget {
	readonly estimator: TokenEstimator;
	readonly tokens: number;
	readonly source: "outbound-context" | "history-fallback";
}

/**
 * Measure parent headroom independently from consensus input. Prefer a complete
 * outbound snapshot (system/tools included), then add only history growth after
 * that snapshot. Older snapshots without a baseline use the larger estimate rather
 * than summing two representations of the same history. Without a snapshot,
 * history-only budgeting is approximate and the reserve is essential.
 */
export const parentResultBudget = Effect.fn("packModels.parentResultBudget")(
	function* (
		ctx: Plugin.Context,
		sessionID: string,
		settings: ConsensusConfig,
		snapshot?: ParentContextSnapshot,
	) {
		const parent = yield* ctx.session.get({
			sessionID: SessionID.make(sessionID),
		});
		let ref = parent.model;
		if (!ref && parent.agent)
			ref = (yield* ctx.agent.get({ agentID: parent.agent })).data.model;
		const catalog = (yield* ctx.model.list()).data;
		const model =
			catalog.find(
				(candidate) =>
					candidate.providerID === ref?.providerID && candidate.id === ref.id,
			) ?? (!ref ? (yield* ctx.model.default()).data : undefined);
		if (!model)
			return yield* Effect.fail(
				new Error("Parent model unavailable for result budgeting"),
			);
		const estimator = tokenEstimator(model.providerID, model.id);
		const history = yield* ctx.session.context({
			sessionID: SessionID.make(sessionID),
		});
		const historyTokens = estimator.count(JSON.stringify(history));
		const matching =
			snapshot?.model.providerID === model.providerID &&
			snapshot.model.id === model.id;
		const used = matching
			? snapshot.historyTokens === undefined
				? Math.max(snapshot.tokens, historyTokens)
				: snapshot.tokens + Math.max(0, historyTokens - snapshot.historyTokens)
			: historyTokens;
		// Reserve wrapper/notification overhead as well as continuation capacity.
		const wrapper =
			estimator.count(
				`<subagent sessionID="${sessionID}" state="completed"></subagent>`,
			) + 64;
		const safeCapacity = safeInputTokenLimit({
			providerID: model.providerID,
			modelID: model.id,
			limit: model.limit,
		});
		// Scale continuation room down for small models; no hidden result ceiling.
		const continuationReserve =
			settings.parentReserveTokens ??
			Math.floor(Math.min(4096, safeCapacity * 0.05));
		const capacity = safeCapacity - used - continuationReserve - wrapper;
		return {
			estimator,
			tokens: resolveTokenLimit(capacity, settings.maxResultToken),
			source: matching ? "outbound-context" : "history-fallback",
		} satisfies ParentResultBudget;
	},
);
