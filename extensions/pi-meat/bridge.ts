import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	PROTOCOL_VERSION,
	type BridgeEvent,
	type GenerateRequest,
	type MeatResult,
} from "./protocol.ts";

export interface RunBridgeOptions {
	repoRoot: string;
	diff: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onGenerate: (request: GenerateRequest) => Promise<AssistantMessage>;
}

export async function runBridge(options: RunBridgeOptions): Promise<MeatResult> {
	const command = resolveBridgeCommand();
	const child = spawn(command.file, command.args, {
		cwd: command.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1" },
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });

	const abort = () => child.kill("SIGTERM");
	options.signal?.addEventListener("abort", abort, { once: true });

	try {
		const result = new Promise<MeatResult>((resolveResult, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				fn();
			};

			child.once("error", (error) => finish(() => reject(error)));
			child.once("exit", (code, signal) => {
				if (settled) return;
				const reason = options.signal?.aborted
					? "Meat run cancelled"
					: `Meat bridge exited (${signal ?? code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
				finish(() => reject(new Error(reason)));
			});

			void (async () => {
				const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
				try {
					for await (const line of lines) {
						if (!line.trim()) continue;
						const event = JSON.parse(line) as BridgeEvent;
						if (event.type === "ready") continue;
						if (event.type === "progress") {
							options.onProgress?.(event.message);
							continue;
						}
						if (event.type === "generate") {
							try {
								const response = await options.onGenerate(event);
								writeLine(child, {
									type: "generate_result",
									id: event.id,
									content: await import("./protocol.ts").then(({ fromPiResponse }) => fromPiResponse(response)),
									input_tokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
									output_tokens: response.usage.output,
								});
							} catch (error) {
								writeLine(child, {
									type: "generate_result",
									id: event.id,
									content: [],
									input_tokens: 0,
									output_tokens: 0,
									error: error instanceof Error ? error.message : String(error),
								});
							}
							continue;
						}
						if (event.type === "error") {
							finish(() => reject(new Error(event.message)));
							child.kill();
							return;
						}
						if (event.type === "result") {
							finish(() => resolveResult({
								summary: event.summary,
								smartDiff: event.smart_diff,
								inputTokens: event.input_tokens,
								outputTokens: event.output_tokens,
							}));
							child.kill();
							return;
						}
					}
				} catch (error) {
					finish(() => reject(error));
					child.kill();
				}
			})();

			writeLine(child, {
				type: "abridge",
				protocol_version: PROTOCOL_VERSION,
				repo_root: options.repoRoot,
				diff: options.diff,
			});
		});
		return await result;
	} finally {
		options.signal?.removeEventListener("abort", abort);
		if (!child.killed) child.kill();
	}
}

function writeLine(child: ReturnType<typeof spawn>, value: unknown): void {
	const stdin = child.stdin;
	if (!stdin?.writable) throw new Error("Meat bridge stdin is closed");
	stdin.write(`${JSON.stringify(value)}\n`);
}

function resolveBridgeCommand(): { file: string; args: string[]; cwd: string } {
	const extensionDir = dirname(fileURLToPath(import.meta.url));
	const packageRoot = resolve(extensionDir, "../..");
	const configured = process.env.PI_MEAT_BRIDGE;
	if (configured) return { file: configured, args: [], cwd: packageRoot };

	const executable = process.platform === "win32" ? "pi-meat-bridge.exe" : "pi-meat-bridge";
	const bundled = join(packageRoot, "bin", executable);
	try {
		accessSync(bundled, constants.X_OK);
		return { file: bundled, args: [], cwd: packageRoot };
	} catch {
		return { file: "go", args: ["run", "."], cwd: join(packageRoot, "bridge") };
	}
}
