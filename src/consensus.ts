import { TRUNCATION_MARKER } from "./constants.ts";
import type { PackWorkerRecord } from "./group-manager.ts";

export interface WorkerResult {
	worker: PackWorkerRecord;
	status: PackWorkerRecord["status"];
	durationMs: number;
	text: string;
}

/** Budget response bodies fairly when presenting evidence to the coordinator. */
export function fairTruncate(
	texts: readonly string[],
	budget: number,
): string[] {
	const result = texts.map(() => "");
	let remaining = Math.max(0, Math.floor(budget));
	const ordered = texts
		.map((text, index) => ({ text, index }))
		.sort((a, b) => a.text.length - b.text.length);
	ordered.forEach(({ text, index }, i) => {
		const quota = Math.min(
			text.length,
			Math.floor(remaining / (ordered.length - i)),
		);
		result[index] =
			text.length <= quota
				? text
				: quota >= TRUNCATION_MARKER.length
					? text.slice(0, quota - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
					: TRUNCATION_MARKER.slice(0, quota);
		remaining -= quota;
	});
	return result;
}

/** Keep reports focused on worker responses; metadata lives in native sessions. */
export function formatDirect(results: readonly WorkerResult[]): string {
	return results.map((r) => `## ${r.worker.label}\n\n${r.text}`).join("\n\n");
}
