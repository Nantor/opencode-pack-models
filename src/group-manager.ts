import type { Plugin } from "@opencode/plugin/effect";
import { Context, DateTime, Effect, Schema } from "effect";
import {
	GROUP_STORAGE_PREFIX,
	PLUGIN_ID,
	WORKER_STORAGE_PREFIX,
} from "./constants.ts";
import type { ResolvedWorker } from "./models.ts";
import { SessionID } from "./session-id.ts";

/**
 * Persistence boundary for real coordinator/worker session membership.
 * The group record is saved in plugin storage separately from native sessions.
 */

// Status is persisted with each worker, including interruption and timeout.
// Mutable arrays permit in-place status updates during a run and follow-ups.
const WorkerSchema = Schema.Struct({
	workerId: Schema.String,
	label: Schema.String,
	providerID: Schema.String,
	modelID: Schema.String,
	effort: Schema.optionalKey(Schema.String),
	useHookEffort: Schema.Boolean,
	// Optional so groups persisted before token budgeting still decode on reload.
	inputTokenLimit: Schema.optionalKey(Schema.Number),
	sessionID: Schema.String,
	status: Schema.Literals([
		"pending",
		"running",
		"succeeded",
		"failed",
		"timed_out",
		"cancelled",
	]),
});
export const GroupSchema = Schema.Struct({
	groupSessionID: Schema.String,
	packId: Schema.String,
	agentId: Schema.String,
	parentSessionID: Schema.String,
	enableInterAgentMessaging: Schema.Boolean,
	workers: Schema.mutable(Schema.Array(WorkerSchema)),
	createdAt: Schema.Number,
	warnings: Schema.optionalKey(Schema.Array(Schema.String)),
});
/** Mutable worker state plus the native session reused across follow-ups. */
export type PackWorkerRecord = ResolvedWorker & {
	sessionID: string;
	status: typeof WorkerSchema.Type.status;
};
/** A coordinator with ordered worker sessions and its originating parent. */
export interface PackGroupRecord
	extends Omit<typeof GroupSchema.Type, "workers" | "warnings"> {
	workers: PackWorkerRecord[];
	warnings?: readonly string[];
}

/**
 * Interface for group storage and coordinator audit writes. Keeping these
 * operations together lets the runner avoid knowledge of storage keys.
 */
export class PackGroupManager extends Context.Service<
	PackGroupManager,
	{
		createGroup(input: {
			packId: string;
			agentId: string;
			parentSessionID: string;
			description: string;
			enableInterAgentMessaging: boolean;
		}): Effect.Effect<PackGroupRecord, unknown>;
		getGroup(id: string): Effect.Effect<PackGroupRecord | undefined, unknown>;
		getWorkerGroup(id: string): Effect.Effect<string | undefined, unknown>;
		save(group: PackGroupRecord): Effect.Effect<void>;
		discard(group: PackGroupRecord): Effect.Effect<void>;
	}
>()(`${PLUGIN_ID}/PackGroupManager`) {}

/**
 * Build a manager with an in-memory read cache over ctx.storage. Storage keys
 * `pack_group/<coordinator ID>` hold encoded records; `pack_worker/<worker ID>`
 * provides reverse lookup to reject direct worker-session follow-ups.
 */
export function makeGroupManager(
	ctx: Plugin.Context,
): PackGroupManager["Service"] {
	const cache = new Map<string, PackGroupRecord>();
	// Save the group first, then each reverse index. Incomplete initial setup
	// is discarded by prepareGroup; subsequent status updates reuse these IDs.
	const save = Effect.fn("PackGroupManager.save")(function* (
		group: PackGroupRecord,
	) {
		yield* ctx.storage.set(
			`${GROUP_STORAGE_PREFIX}${group.groupSessionID}`,
			yield* Schema.encodeEffect(GroupSchema)(group).pipe(Effect.orDie),
		);
		cache.set(group.groupSessionID, group);
		for (const worker of group.workers)
			yield* ctx.storage.set(
				`${WORKER_STORAGE_PREFIX}${worker.sessionID}`,
				group.groupSessionID,
			);
	});
	return PackGroupManager.of({
		save,
		// Discard persistence and indexes, not the native sessions themselves.
		discard: Effect.fn("PackGroupManager.discard")(function* (group) {
			cache.delete(group.groupSessionID);
			yield* ctx.storage.remove(
				`${GROUP_STORAGE_PREFIX}${group.groupSessionID}`,
			);
			for (const worker of group.workers)
				yield* ctx.storage.remove(
					`${WORKER_STORAGE_PREFIX}${worker.sessionID}`,
				);
		}),
		createGroup: Effect.fn("PackGroupManager.createGroup")(function* (input) {
			// The coordinator is a child of the calling parent session; workers
			// will be created beneath it once model resolution has succeeded.
			const session = yield* ctx.session.create({
				parentID: SessionID.make(input.parentSessionID),
				title: `[Pack: ${input.packId}] ${input.description}`,
				metadata: { packModels: { role: "coordinator", packId: input.packId } },
			});
			const group: PackGroupRecord = {
				groupSessionID: session.id,
				packId: input.packId,
				agentId: input.agentId,
				parentSessionID: input.parentSessionID,
				enableInterAgentMessaging: input.enableInterAgentMessaging,
				workers: [],
				createdAt: DateTime.toEpochMillis(yield* DateTime.now),
			};
			return group;
		}),
		getWorkerGroup: Effect.fn("PackGroupManager.getWorkerGroup")(
			function* (id) {
				const indexed = yield* ctx.storage.get(`${WORKER_STORAGE_PREFIX}${id}`);
				if (typeof indexed === "string") return indexed;
				// Read the native parent link as well, for groups saved before the index existed.
				const session = yield* ctx.session
					.get({ sessionID: id as typeof SessionID.Type })
					.pipe(Effect.catch(() => Effect.succeed(undefined)));
				if (
					session?.parentID &&
					(yield* ctx.storage.get(
						`${GROUP_STORAGE_PREFIX}${session.parentID}`,
					)) !== undefined
				)
					return session.parentID;
				return undefined;
			},
		),
		getGroup: Effect.fn("PackGroupManager.getGroup")(function* (id) {
			// Decode persisted data on cache miss (for example after plugin reload).
			const cached = cache.get(id);
			if (cached) return cached;
			const stored = yield* ctx.storage.get(`${GROUP_STORAGE_PREFIX}${id}`);
			if (stored === undefined) return undefined;
			const group = yield* Schema.decodeUnknownEffect(GroupSchema)(stored);
			cache.set(id, group);
			return group;
		}),
	});
}
