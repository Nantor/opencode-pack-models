import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { SCRIPTED_PROVIDER_ID } from "./constants.ts";

/** Request/response contract shared by local scripted model adapters. */
export type ScriptedResponder = (
	options: LanguageModelV3CallOptions,
) => Promise<LanguageModelV3GenerateResult>;

/** Local protocol adapter: native transcript events, no model/provider request. */
export function scriptedModel(
	modelId: string,
	respond: ScriptedResponder,
): LanguageModelV3 {
	return {
		specificationVersion: "v3",
		provider: SCRIPTED_PROVIDER_ID,
		modelId,
		supportedUrls: {},
		doGenerate: respond,
		doStream: async (options: LanguageModelV3CallOptions) => {
			const result = await respond(options);
			return {
				stream: new ReadableStream<LanguageModelV3StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						for (const [index, part] of result.content.entries()) {
							if (part.type === "tool-call") controller.enqueue(part);
							else if (part.type === "text") {
								const id = `text-${index}`;
								controller.enqueue({ type: "text-start", id });
								controller.enqueue({
									type: "text-delta",
									id,
									delta: part.text,
								});
								controller.enqueue({ type: "text-end", id });
							}
						}
						controller.enqueue({
							type: "finish",
							finishReason: result.finishReason,
							usage: result.usage,
						});
						controller.close();
					},
				}),
			};
		},
	};
}

export const scriptedUsage: LanguageModelV3Usage = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
};
