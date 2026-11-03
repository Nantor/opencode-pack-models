import { expect, test } from "bun:test";
import { scriptedModel, scriptedUsage } from "../src/scripted-model.ts";

test("local model streams native tool calls and final text with zero model usage", async () => {
	let calls = 0;
	const model = scriptedModel("static", async () => ({
		content:
			calls++ === 0
				? [
						{
							type: "tool-call",
							toolCallId: "worker-call",
							toolName: "subagent",
							input: '{"sessionID":"ses_worker"}',
						},
					]
				: [{ type: "text", text: "Static final report" }],
		finishReason: {
			unified: calls === 1 ? "tool-calls" : "stop",
			raw: undefined,
		},
		usage: scriptedUsage,
		warnings: [],
	}));
	const first = await model.doStream({ prompt: [] });
	const parts = [];
	for await (const part of first.stream) parts.push(part);
	expect(parts).toContainEqual({
		type: "tool-call",
		toolCallId: "worker-call",
		toolName: "subagent",
		input: '{"sessionID":"ses_worker"}',
	});
	const final = await model.doStream({ prompt: [] });
	const finalParts = [];
	for await (const part of final.stream) finalParts.push(part);
	expect(finalParts).toContainEqual({
		type: "text-delta",
		id: "text-0",
		delta: "Static final report",
	});
	expect(finalParts.at(-1)).toMatchObject({
		type: "finish",
		usage: scriptedUsage,
	});
});
