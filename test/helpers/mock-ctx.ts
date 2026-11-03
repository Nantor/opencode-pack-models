// In-memory, Map-backed fake of the OpenCode Effect plugin `ctx` surfaces that
// the pack-models modules depend on. This mirrors the shapes from
// `@opencode/plugin/effect` closely enough for unit tests without spinning up a
// real OpenCode server or making any LLM calls.
//
// The mock intentionally keeps the real API shape (`Effect`-returning methods
// via `Effect.sync`/`Effect.succeed`) so tests exercise the same call sites the
// production code uses. It is NOT a full implementation of every OpenCode API —
// it covers only what the plugin currently touches.
//
// Extend this file as modules land so the fake stays in lock-step with the
// plugin's `src/` modules.
import {} from "@opencode/plugin/effect";
import { Effect, type Schema } from "effect";

export interface MockWorkerMessage {
	readonly sessionID: string;
	readonly text: string | null;
	readonly status: "running" | "succeeded" | "failed" | "timed_out";
}

export interface MockSessionRecord {
	readonly id: string;
	title: string;
	agent?: string;
	model?: { providerID: string; id: string; variant?: string };
	messages: Array<{ role: string; text: string }>;
	instructions: Map<string, unknown>;
}

export interface MockCtx {
	readonly storage: StorageMemory;
	readonly session: SessionMemory;
}

/** Map-backed fake of `ctx.storage` with prefix scan. */
export class StorageMemory {
	readonly map = new Map<string, Schema.Json>();

	get = (key: string): Effect.Effect<Schema.Json | undefined> =>
		Effect.succeed(this.map.get(key));

	set = (key: string, value: Schema.Json): Effect.Effect<void> =>
		Effect.sync(() => {
			this.map.set(key, value);
		});

	remove = (key: string): Effect.Effect<void> =>
		Effect.sync(() => {
			this.map.delete(key);
		});

	scan = (options: {
		prefix: string;
		after?: string;
		limit?: number;
	}): Effect.Effect<{
		entries: Array<{ key: string; value: Schema.Json }>;
		next?: string;
	}> =>
		Effect.sync(() => {
			let entries = [...this.map.entries()].filter(([key]) =>
				key.startsWith(options.prefix),
			);
			if (options.after) {
				const after = options.after;
				entries = entries.filter(([key]) => key > after);
			}
			entries = entries.slice(0, options.limit ?? entries.length);
			const last = entries.length ? entries.at(-1)?.[0] : undefined;
			const result: {
				entries: Array<{ key: string; value: Schema.Json }>;
				next?: string;
			} = {
				entries: entries.map(([key, value]) => ({ key, value })),
			};
			if (last !== undefined) result.next = last;
			return result;
		});
}

/**
 * In-memory session store. `create` returns a durable record; `prompt` appends a
 * worker message and, by default, immediately resolves (tests can override the
 * assistant responses via `MockCtxOptions`). `wait` resolves immediately.
 */
export class SessionMemory {
	readonly sessions = new Map<string, MockSessionRecord>();
	private nextId = 1;

	/** Controls how `prompt` answers. Map key = sessionID. */
	responses = new Map<string, Array<string>>();

	create = (input?: { title?: string }): Effect.Effect<MockSessionRecord> =>
		Effect.sync(() => {
			const id = `session-${this.nextId++}`;
			const record: MockSessionRecord = {
				id,
				title: input?.title ?? id,
				messages: [],
				instructions: new Map(),
			};
			this.sessions.set(id, record);
			return record;
		});

	get = (input: { sessionID: string }): Effect.Effect<
		MockSessionRecord | undefined
	> => Effect.succeed(this.sessions.get(input.sessionID));

	context = (input: { sessionID: string }): Effect.Effect<
		Array<{ role: string; text: string }>
	> => Effect.succeed(this.sessions.get(input.sessionID)?.messages ?? []);

	synthetic = (input: {
		sessionID: string;
		text: string;
	}): Effect.Effect<void> =>
		Effect.sync(() => {
			this.pushMessage(input.sessionID, {
				role: "synthetic",
				text: input.text,
			});
		});

	switchAgent = (input: {
		sessionID: string;
		agent: string;
	}): Effect.Effect<void> =>
		Effect.sync(() => {
			const record = this.sessions.get(input.sessionID);
			if (record) record.agent = input.agent;
		});

	switchModel = (input: {
		sessionID: string;
		model: { providerID: string; id: string; variant?: string };
	}): Effect.Effect<void> =>
		Effect.sync(() => {
			const record = this.sessions.get(input.sessionID);
			if (record) record.model = input.model;
		});

	prompt = (input: { sessionID: string; text: string }): Effect.Effect<void> =>
		Effect.sync(() => {
			this.pushMessage(input.sessionID, { role: "user", text: input.text });
			const replies = this.responses.get(input.sessionID);
			const reply = replies?.shift() ?? `[mock reply to: ${input.text}]`;
			this.pushMessage(input.sessionID, { role: "assistant", text: reply });
		});

	interrupt = (input: { sessionID: string }): Effect.Effect<{
		interrupted: boolean;
	}> => Effect.succeed({ interrupted: true });

	wait = (input: { sessionID: string }): Effect.Effect<void> =>
		Effect.succeed(void 0);

	instructions = {
		entry: {
			put: (input: {
				sessionID: string;
				key: string;
				value: unknown;
			}): Effect.Effect<void> =>
				Effect.sync(() => {
					const record = this.sessions.get(input.sessionID);
					record?.instructions.set(input.key, input.value);
				}),
			remove: (input: {
				sessionID: string;
				key: string;
			}): Effect.Effect<void> =>
				Effect.sync(() => {
					this.sessions.get(input.sessionID)?.instructions.delete(input.key);
				}),
			list: (input: { sessionID: string }): Effect.Effect<
				Array<{ key: string; value: unknown }>
			> =>
				Effect.sync(() => {
					const record = this.sessions.get(input.sessionID);
					return record
						? [...record.instructions.entries()].map(([key, value]) => ({
								key,
								value,
							}))
						: [];
				}),
		},
	};

	private pushMessage(
		sessionID: string,
		message: { role: string; text: string },
	) {
		const record = this.sessions.get(sessionID);
		if (record) record.messages.push(message);
	}
}

/** Build a fresh mock `ctx` with isolated storage + session stores. */
export function makeMockCtx(): MockCtx {
	return {
		storage: new StorageMemory(),
		session: new SessionMemory(),
	};
}
