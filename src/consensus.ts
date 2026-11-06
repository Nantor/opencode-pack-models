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

/**
 * Share an estimated token budget fairly, processing short answers first so
 * unused quota flows to longer answers. The caller supplies matching count and
 * truncate functions; markers are included in each response's quota. Request
 * instructions, labels and separators must be reserved separately by the caller.
 */
export function fairTruncateTokens(
	texts: readonly string[],
	budget: number,
	count: (text: string) => number,
	truncate: (text: string, maxTokens: number, marker: string) => string,
): string[] {
	const result = texts.map(() => "");
	let remaining = Math.max(0, Math.floor(budget));
	const ordered = texts
		.map((text, index) => ({ text, index, tokens: count(text) }))
		.sort((a, b) => a.tokens - b.tokens);
	ordered.forEach(({ text, index, tokens }, i) => {
		const quota = Math.min(
			tokens,
			Math.floor(remaining / (ordered.length - i)),
		);
		let value =
			tokens <= quota ? text : truncate(text, quota, TRUNCATION_MARKER);
		let actual = count(value);
		let adjustedQuota = quota;
		while (actual > quota && adjustedQuota > 0) {
			const prevQuota = adjustedQuota;
			adjustedQuota = Math.max(0, adjustedQuota - Math.max(1, actual - quota));
			value = truncate(text, adjustedQuota, TRUNCATION_MARKER);
			actual = count(value);
			if (adjustedQuota === prevQuota) break;
		}
		if (actual > quota) {
			value = "";
			actual = 0;
		}
		result[index] = value;
		remaining = Math.max(0, remaining - actual);
	});
	return result;
}

/** Keep reports focused on worker responses; metadata lives in native sessions. */
export function formatDirect(results: readonly WorkerResult[]): string {
	return results.map((r) => `## ${r.worker.label}\n\n${r.text}`).join("\n\n");
}
