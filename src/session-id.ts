import { Schema } from "effect";
import { NATIVE_SESSION_ID_PREFIX } from "./constants.ts";

/**
 * Locally brand native session IDs for host API calls. The host bridge does
 * not expose the Session schema; matching its public `ses` prefix avoids
 * loading a second runtime copy of @opencode/schema. This is not a lookup or
 * a guarantee that the session exists: storage/session APIs validate usage.
 */
export const SessionID = Schema.String.check(
	Schema.isStartingWith(NATIVE_SESSION_ID_PREFIX),
).pipe(Schema.brand("SessionID"));
