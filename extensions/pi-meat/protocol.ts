import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";

export const PROTOCOL_VERSION = 1;
export const PROVIDER_STATE = "pi-meat/pi-ai-assistant-v1";

export interface WireBlock {
	type: "text" | "tool_use" | "tool_result" | "provider_state";
	text?: string;
	id?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_use_id?: string;
	tool_result?: string;
	tool_error?: boolean;
	provider?: string;
	provider_data?: unknown;
}

export interface WireMessage {
	role: "user" | "assistant";
	content: WireBlock[];
}

export interface WireTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

export interface GenerateRequest {
	type: "generate";
	id: number;
	system: string;
	messages: WireMessage[];
	tools: WireTool[];
}

export type BridgeEvent =
	| { type: "ready"; protocol_version: number }
	| { type: "progress"; message: string }
	| GenerateRequest
	| {
			type: "result";
			summary: string;
			smart_diff: string;
			input_tokens?: number;
			output_tokens?: number;
	  }
	| { type: "error"; message: string };

export interface MeatResult {
	summary: string;
	smartDiff: string;
	inputTokens: number;
	outputTokens: number;
}

export function toPiContext(request: GenerateRequest): {
	messages: Message[];
	tools: Tool[];
} {
	const messages: Message[] = [];
	const toolNames = new Map<string, string>();

	for (const message of request.messages) {
		if (message.role === "assistant") {
			const saved = message.content.find(
				(block) =>
					block.type === "provider_state" && block.provider === PROVIDER_STATE,
			)?.provider_data;
			if (saved && typeof saved === "object") {
				const assistant = saved as AssistantMessage;
				messages.push(assistant);
				for (const part of assistant.content) {
					if (part.type === "toolCall") toolNames.set(part.id, part.name);
				}
				continue;
			}

			const content: AssistantMessage["content"] = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text)
					content.push({ type: "text", text: block.text });
				if (block.type === "tool_use" && block.id && block.tool_name) {
					content.push({
						type: "toolCall",
						id: block.id,
						name: block.tool_name,
						arguments: asObject(block.tool_input),
					});
					toolNames.set(block.id, block.tool_name);
				}
			}
			messages.push({
				role: "assistant",
				content,
				api: "pi-messages",
				provider: "pi-meat",
				model: "bridge",
				usage: emptyUsage(),
				stopReason: content.some((part) => part.type === "toolCall")
					? "toolUse"
					: "stop",
				timestamp: Date.now(),
			});
			continue;
		}

		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
		if (text)
			messages.push({
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			});
		for (const block of message.content) {
			if (block.type !== "tool_result" || !block.tool_use_id) continue;
			messages.push({
				role: "toolResult",
				toolCallId: block.tool_use_id,
				toolName: toolNames.get(block.tool_use_id) ?? "unknown",
				content: [{ type: "text", text: block.tool_result ?? "" }],
				details: {},
				isError: block.tool_error ?? false,
				timestamp: Date.now(),
			});
		}
	}

	return {
		messages,
		tools: request.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.input_schema as Tool["parameters"],
		})),
	};
}

export function fromPiResponse(response: AssistantMessage): WireBlock[] {
	const blocks: WireBlock[] = [
		{
			type: "provider_state",
			provider: PROVIDER_STATE,
			provider_data: response,
		},
	];
	for (const part of response.content) {
		if (part.type === "text") blocks.push({ type: "text", text: part.text });
		if (part.type === "toolCall") {
			blocks.push({
				type: "tool_use",
				id: part.id,
				tool_name: part.name,
				tool_input: asObject(part.arguments),
			});
		}
	}
	return blocks;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
