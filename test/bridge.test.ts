import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { runBridge } from "../extensions/pi-meat/bridge.ts";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "late response" }],
	api: "openai-responses",
	provider: "openai",
	model: "example",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};

const submissionAssistant: AssistantMessage = {
	...assistant,
	content: [
		{
			type: "toolCall",
			id: "submit-1",
			name: "submit",
			arguments: {
				remove: [],
				replace: [],
				fold: [],
				summary: "Changes value",
			},
		},
	],
	stopReason: "toolUse",
};

test("accepts a result written immediately before bridge exit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-result-"));
	const executable = join(directory, "fake-bridge.cjs");
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.stdin.once("data", () => {
	process.stdout.write(JSON.stringify({ type: "ready", protocol_version: 1 }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "result", summary: "done", smart_diff: "diff", input_tokens: 2, output_tokens: 3 }) + "\\n", () => process.exit(0));
});
`,
	);
	await chmod(executable, 0o755);
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = executable;
	try {
		assert.deepEqual(
			await runBridge({
				diff: "diff",
				onGenerate: async () => assistant,
			}),
			{
				summary: "done",
				smartDiff: "diff",
				inputTokens: 2,
				outputTokens: 3,
			},
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
		await rm(directory, { recursive: true, force: true });
	}
});

test("does not pass ambient secrets to bridge process", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-env-"));
	const executable = join(directory, "fake-bridge.cjs");
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.stdin.once("data", () => {
	process.stdout.write(JSON.stringify({ type: "ready", protocol_version: 1 }) + "\\n");
	const summary = (process.env.PI_MEAT_TEST_SECRET ?? "absent") + ":" + (process.env.PATH ? "path" : "no-path");
	process.stdout.write(JSON.stringify({ type: "result", summary, smart_diff: "diff", input_tokens: 0, output_tokens: 0 }) + "\\n");
});
`,
	);
	await chmod(executable, 0o755);
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	const previousSecret = process.env.PI_MEAT_TEST_SECRET;
	process.env.PI_MEAT_BRIDGE = executable;
	process.env.PI_MEAT_TEST_SECRET = "must-not-leak";
	try {
		const result = await runBridge({
			diff: "diff",
			onGenerate: async () => assistant,
		});
		assert.equal(result.summary, "absent:path");
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
		if (previousSecret === undefined) delete process.env.PI_MEAT_TEST_SECRET;
		else process.env.PI_MEAT_TEST_SECRET = previousSecret;
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects incompatible bridge protocol", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-protocol-"));
	const executable = join(directory, "fake-bridge.cjs");
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.stdin.once("data", () => {
	process.stdout.write(JSON.stringify({ type: "ready", protocol_version: 99 }) + "\\n");
});
`,
	);
	await chmod(executable, 0o755);
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = executable;
	try {
		await assert.rejects(
			runBridge({
				diff: "diff",
				onGenerate: async () => assistant,
			}),
			/protocol mismatch/,
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects malformed generate blocks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-schema-"));
	const executable = join(directory, "fake-bridge.cjs");
	await writeFile(
		executable,
		`process.stdin.once("data", () => {
	process.stdout.write(JSON.stringify({ type: "ready", protocol_version: 1 }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "generate", id: 1, system: "", tools: [], messages: [{ role: "user", content: [{ type: "unknown" }] }] }) + "\\n");
});
`,
	);
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = executable;
	try {
		await assert.rejects(
			runBridge({ diff: "diff", onGenerate: async () => assistant }),
			/invalid generate event/,
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects out-of-order generate ids", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-order-"));
	const executable = join(directory, "fake-bridge.cjs");
	await writeFile(
		executable,
		`process.stdin.once("data", () => {
	process.stdout.write(JSON.stringify({ type: "ready", protocol_version: 1 }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "generate", id: 2, system: "", tools: [], messages: [] }) + "\\n");
});
`,
	);
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = executable;
	try {
		await assert.rejects(
			runBridge({ diff: "diff", onGenerate: async () => assistant }),
			/generate id out of order/,
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects streamed bridge events above limit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-output-"));
	const executable = join(directory, "fake-bridge.cjs");
	await writeFile(
		executable,
		`process.stdin.once("data", () => {
	const chunk = "x".repeat(1024 * 1024);
	for (let index = 0; index < 33; index++) process.stdout.write(chunk);
});
`,
	);
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = executable;
	try {
		await assert.rejects(
			runBridge({ diff: "diff", onGenerate: async () => assistant }),
			/event exceeds 32 MiB limit/,
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects pre-aborted runs before spawning", async () => {
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = "/path/that/must/not/spawn";
	const controller = new AbortController();
	controller.abort();
	try {
		await assert.rejects(
			runBridge({
				diff: "diff",
				signal: controller.signal,
				onGenerate: async () => assistant,
			}),
			/Meat run cancelled/,
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
	}
});

test("rejects oversized diffs before spawning bridge", async () => {
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = "/path/that/must/not/spawn";
	try {
		await assert.rejects(
			runBridge({
				diff: "x".repeat(16 * 1024 * 1024 + 1),
				onGenerate: async () => assistant,
			}),
			/16 MiB safety limit/,
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
	}
});

test("rejects serialized diffs above scanner-safe limit", async () => {
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = "/path/that/must/not/spawn";
	try {
		await assert.rejects(
			runBridge({
				diff: '"'.repeat(16 * 1024 * 1024),
				onGenerate: async () => assistant,
			}),
			/31 MiB safety limit/,
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
	}
});

test("keeps repository read tools out of model requests", async () => {
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	delete process.env.PI_MEAT_BRIDGE;
	try {
		const result = await runBridge({
			diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
			onGenerate: async (request) => {
				assert.deepEqual(
					request.tools.map((tool) => tool.name),
					["preview_plan", "submit"],
				);
				return submissionAssistant;
			},
		});
		assert.equal(result.summary, "Changes value");
	} finally {
		if (previousBridge !== undefined)
			process.env.PI_MEAT_BRIDGE = previousBridge;
	}
});

test("recovers when a model tool call has malformed arguments", async () => {
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	delete process.env.PI_MEAT_BRIDGE;
	let turn = 0;
	try {
		const result = await runBridge({
			diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
			onGenerate: async () => {
				turn++;
				if (turn === 1)
					return {
						...assistant,
						content: [
							{
								type: "toolCall",
								id: "malformed-1",
								name: "preview_plan",
								arguments: undefined as unknown as Record<string, unknown>,
							},
						],
						stopReason: "toolUse",
					};
				return submissionAssistant;
			},
		});
		assert.equal(turn, 2);
		assert.equal(result.summary, "Changes value");
	} finally {
		if (previousBridge !== undefined)
			process.env.PI_MEAT_BRIDGE = previousBridge;
	}
});

test("does not write to bridge stdin after cancellation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-"));
	const executable = join(directory, "fake-bridge.cjs");
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.stdin.once("data", () => {
	process.stdout.write(JSON.stringify({ type: "ready", protocol_version: 1 }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "generate", id: 1, system: "", tools: [], messages: [] }) + "\\n");
});
setInterval(() => {}, 1_000);
`,
	);
	await chmod(executable, 0o755);

	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = executable;
	const controller = new AbortController();
	try {
		await assert.rejects(
			runBridge({
				diff: "diff",
				signal: controller.signal,
				onGenerate: async () => {
					controller.abort();
					await new Promise((resolve) => setTimeout(resolve, 50));
					return assistant;
				},
			}),
			/Meat run cancelled/,
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
		await rm(directory, { recursive: true, force: true });
	}
});

test("turns closed bridge stdin into controlled rejection", {
	skip: process.platform === "win32",
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-closed-"));
	const executable = join(directory, "fake-bridge.cjs");
	await writeFile(
		executable,
		`#!/usr/bin/env node
const fs = require("node:fs");
process.stdin.on("error", () => {});
process.stdin.once("data", () => {
	fs.closeSync(0);
	process.stdout.write(JSON.stringify({ type: "ready", protocol_version: 1 }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "generate", id: 1, system: "", tools: [], messages: [] }) + "\\n");
});
setInterval(() => {}, 1_000);
`,
	);
	await chmod(executable, 0o755);
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = executable;
	try {
		await assert.rejects(
			runBridge({
				diff: "diff",
				onGenerate: async () => assistant,
			}),
			/EPIPE|stdin is closed|bridge exited/,
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
		await rm(directory, { recursive: true, force: true });
	}
});

test("forces bridge shutdown when child ignores SIGTERM", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-stubborn-"));
	const executable = join(directory, "fake-bridge.cjs");
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdin.once("data", () => {
	process.stdout.write(JSON.stringify({ type: "ready", protocol_version: 1 }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "generate", id: 1, system: "", tools: [], messages: [] }) + "\\n");
});
setInterval(() => {}, 1_000);
`,
	);
	await chmod(executable, 0o755);
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = executable;
	const controller = new AbortController();
	const started = Date.now();
	try {
		await assert.rejects(
			runBridge({
				diff: "diff",
				signal: controller.signal,
				onGenerate: async () => {
					controller.abort();
					return assistant;
				},
			}),
			/Meat run cancelled/,
		);
		assert.ok(
			Date.now() - started < 2_500,
			"stubborn bridge must be force-killed promptly",
		);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_MEAT_BRIDGE;
		else process.env.PI_MEAT_BRIDGE = previousBridge;
		await rm(directory, { recursive: true, force: true });
	}
});
