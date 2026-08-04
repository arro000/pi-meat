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

test("accepts a result written immediately before bridge exit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-result-"));
	const executable = join(directory, "fake-bridge");
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.stdin.once("data", () => {
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
				repoRoot: directory,
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

test("rejects pre-aborted runs before spawning", async () => {
	const previousBridge = process.env.PI_MEAT_BRIDGE;
	process.env.PI_MEAT_BRIDGE = "/path/that/must/not/spawn";
	const controller = new AbortController();
	controller.abort();
	try {
		await assert.rejects(
			runBridge({
				repoRoot: ".",
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

test("does not write to bridge stdin after cancellation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-"));
	const executable = join(directory, "fake-bridge");
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.stdin.once("data", () => {
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
				repoRoot: directory,
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

test("turns closed bridge stdin into controlled rejection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-bridge-closed-"));
	const executable = join(directory, "fake-bridge");
	await writeFile(
		executable,
		`#!/usr/bin/env node
const fs = require("node:fs");
process.stdin.on("error", () => {});
process.stdin.once("data", () => {
	fs.closeSync(0);
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
				repoRoot: directory,
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
	const executable = join(directory, "fake-bridge");
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdin.once("data", () => {
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
				repoRoot: directory,
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
