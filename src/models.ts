import { Model, type Plugin, Provider } from "@opencode/plugin/effect";
import type { ProviderEditor } from "@opencode/plugin/effect/provider";
import { Effect } from "effect";
import type { Config, ModelSpec, PackConfig } from "./config.ts";
import { PACK_PROVIDER_NAME } from "./constants.ts";
import { tokenEstimatorWarning } from "./token-budget.ts";

/**
 * Catalog lookup and registration of the synthetic provider. Pack models are
 * selection targets, not executable provider models: execution uses real
 * catalog models in separate native sessions.
 */

/** One runnable pack member; repeated specs receive distinct worker IDs. */
export interface ResolvedWorker {
	workerId: string;
	label: string;
	providerID: string;
	modelID: string;
	effort?: string;
	useHookEffort: boolean;
	/** Declared input allowance before the safety margin; absent in older groups. */
	inputTokenLimit?: number;
}

/**
 * Convert a resolved member to OpenCode's model reference. Native variants
 * travel with the reference; unsupported efforts instead use the worker-only
 * context hook installed by the plugin.
 */
export function modelRef(worker: ResolvedWorker): Model.Ref {
	return {
		providerID: Provider.ID.make(worker.providerID),
		id: Model.ID.make(worker.modelID),
		...(worker.effort && !worker.useHookEffort
			? { variant: Model.VariantID.make(worker.effort) }
			: {}),
	};
}

/**
 * Match provider and model IDs exactly against enabled catalog entries.
 * Missing/disabled models warn and return undefined, allowing other members
 * to run. A supplied catalog avoids another list request for each member.
 */
export const resolveModel = Effect.fn("resolveModel")(function* (
	ctx: Plugin.Context,
	spec: ModelSpec,
	packProviderId: string,
	catalog?: readonly Model.Info[],
) {
	if (spec.provider === packProviderId)
		return yield* Effect.fail(
			new Error(
				"Virtual pack models cannot be executed as workers or consensus models",
			),
		);
	const models = catalog ?? (yield* ctx.model.list()).data;
	const model = models.find(
		(m) => m.providerID === spec.provider && m.id === spec.model && m.enabled,
	);
	if (!model) {
		yield* Effect.logWarning(
			`Pack model unavailable: ${spec.provider}/${spec.model}`,
		);
		return undefined;
	}
	return {
		providerID: spec.provider,
		modelID: spec.model,
		...(spec.effort ? { effort: spec.effort } : {}),
		useHookEffort:
			!!spec.effort && !model.variants.some((v) => v.id === spec.effort),
		inputTokenLimit:
			model.limit.input ??
			Math.max(0, model.limit.context - model.limit.output),
		workerId: "",
		label: "",
	} satisfies ResolvedWorker;
});

/**
 * Walk configured members in order, retaining duplicates as independent
 * workers. Only available entries count toward the cap; worker IDs are dense
 * and stable for the lifetime of the resulting group.
 */
export const resolvePackWorkers = Effect.fn("resolvePackWorkers")(function* (
	ctx: Plugin.Context,
	pack: PackConfig,
	cap: number,
	packProviderId: string,
	warnings: string[] = [],
) {
	const workers: ResolvedWorker[] = [];
	const catalog = (yield* ctx.model.list()).data;
	for (const spec of pack.models) {
		const resolved = yield* resolveModel(ctx, spec, packProviderId, catalog);
		if (!resolved) {
			warnings.push(
				`Skipped unavailable model: ${spec.provider}/${spec.model}`,
			);
			continue;
		}
		if (workers.length === cap) {
			yield* Effect.logWarning(`Pack worker limit reached (${cap})`);
			warnings.push(
				`Worker limit reached (${cap}); remaining pack members were not run`,
			);
			break;
		}
		const workerId = `worker-${workers.length + 1}`;
		const estimatorWarning = tokenEstimatorWarning(
			resolved.providerID,
			resolved.modelID,
		);
		if (estimatorWarning && !warnings.includes(estimatorWarning)) {
			warnings.push(estimatorWarning);
			yield* Effect.logWarning(estimatorWarning);
		}
		workers.push({
			...resolved,
			workerId,
			label: `${workerId} (${spec.provider}/${spec.model})`,
		});
	}
	return workers;
});

/**
 * Expose each configured pack as `<packProviderId>/<packId>` in the picker.
 * Refuse collisions with an existing provider instead of replacing its models.
 */
export function registerProvider(ctx: Plugin.Context, config: Config) {
	return ctx.provider.transform((editor: ProviderEditor) => {
		if (editor.get(config.packProviderId))
			throw new Error(
				`Pack provider ID already exists: ${config.packProviderId}`,
			);
		const providerID = Provider.ID.make(config.packProviderId);
		editor.add({
			info: {
				...Provider.Info.empty(providerID),
				name: PACK_PROVIDER_NAME,
				activation: "enabled",
			},
			models: Object.keys(config.packs).map((id) => ({
				...Model.Info.default(providerID, Model.ID.make(id)),
				name: `Pack: ${id}`,
			})),
		});
	});
}
