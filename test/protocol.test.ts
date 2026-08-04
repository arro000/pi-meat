import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fromPiResponse, PROVIDER_STATE, toPiContext, type GenerateRequest } from "../extensions/pi-meat/protocol.ts";

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("preserves the native Pi assistant response across Meat tool turns", () => {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "opaque reasoning", thinkingSignature: "signed" },
			{ type: "toolCall", id: "call-1", name: "submit", arguments: { remove: [] } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "example",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
	const blocks = fromPiResponse(assistant);
	assert.equal(blocks[0]?.provider, PROVIDER_STATE);

	const request: GenerateRequest = {
		type: "generate",
		id: 2,
		system: "system",
		tools: [],
		messages: [
			{ role: "assistant", content: blocks },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", tool_result: "ok" }] },
		],
	};
	const context = toPiContext(request);
	assert.equal(context.messages[0], assistant);
	const toolResult = context.messages[1];
	assert.equal(toolResult?.role, "toolResult");
	if (toolResult?.role === "toolResult") assert.equal(toolResult.toolName, "submit");
});
