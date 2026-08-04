import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fromPiResponse,
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

export async function runBridge(
	options: RunBridgeOptions,
): Promise<MeatResult> {
	if (options.signal?.aborted) throw new Error("Meat run cancelled");
	const command = resolveBridgeCommand();
	const child = spawn(command.file, command.args, {
		cwd: command.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1" },
	});
	let stderr = "";
	let settled = false;
	let settle: ((error?: Error, result?: MeatResult) => void) | undefined;
	const closed = new Promise<void>((resolveClose) =>
		child.once("close", () => resolveClose()),
	);

	// Writable streams emit "error" asynchronously even when write() looked safe.
	// Install listener immediately so closed bridge pipe can never reach uncaughtException.
	child.stdin.on("error", (error) => {
		if (!settled)
			settle?.(options.signal?.aborted ? cancelledError() : asError(error));
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-16_384);
	});

	const abort = () => {
		settle?.(cancelledError());
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGTERM");
	};
	options.signal?.addEventListener("abort", abort, { once: true });

	try {
		return await new Promise<MeatResult>((resolveResult, reject) => {
			settle = (error, result) => {
				if (settled) return;
				settled = true;
				if (error) reject(error);
				else if (result) resolveResult(result);
				else reject(new Error("Meat bridge ended without a result"));
			};

			child.once("error", (error) => settle?.(asError(error)));

			const consumer = consumeBridgeEvents(
				child,
				options,
				() => settled,
				(error, result) => settle?.(error, result),
			);
			void consumer
				.then(() => {
					if (settled) return;
					if (options.signal?.aborted) return settle?.(cancelledError());
					const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
					const status = child.signalCode ?? child.exitCode ?? "stdout closed";
					settle?.(
						new Error(
							`Meat bridge ended (${status}) without a result${detail}`,
						),
					);
				})
				.catch((error) => settle?.(asError(error)));
			void writeLine(child, {
				type: "abridge",
				protocol_version: PROTOCOL_VERSION,
				repo_root: options.repoRoot,
				diff: options.diff,
			}).catch((error) =>
				settle?.(options.signal?.aborted ? cancelledError() : asError(error)),
			);
		});
	} finally {
		options.signal?.removeEventListener("abort", abort);
		await terminateChild(child, closed);
	}
}

async function consumeBridgeEvents(
	child: ChildProcessWithoutNullStreams,
	options: RunBridgeOptions,
	isSettled: () => boolean,
	finish: (error?: Error, result?: MeatResult) => void,
): Promise<void> {
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (isSettled()) return;
			if (!line.trim()) continue;
			const event = parseBridgeEvent(line);
			if (event.type === "ready") continue;
			if (event.type === "progress") {
				options.onProgress?.(event.message);
				continue;
			}
			if (event.type === "generate") {
				await answerGenerate(child, event, options, isSettled);
				continue;
			}
			if (event.type === "error") {
				finish(new Error(event.message));
				return;
			}
			finish(undefined, {
				summary: event.summary,
				smartDiff: event.smart_diff,
				inputTokens: event.input_tokens,
				outputTokens: event.output_tokens,
			});
			return;
		}
	} finally {
		lines.close();
	}
}

async function answerGenerate(
	child: ChildProcessWithoutNullStreams,
	event: GenerateRequest,
	options: RunBridgeOptions,
	isSettled: () => boolean,
): Promise<void> {
	try {
		const response = await options.onGenerate(event);
		if (isSettled() || options.signal?.aborted) return;
		await writeLine(child, {
			type: "generate_result",
			id: event.id,
			content: fromPiResponse(response),
			input_tokens:
				response.usage.input +
				response.usage.cacheRead +
				response.usage.cacheWrite,
			output_tokens: response.usage.output,
		});
	} catch (error) {
		if (isSettled() || options.signal?.aborted) return;
		await writeLine(child, {
			type: "generate_result",
			id: event.id,
			content: [],
			input_tokens: 0,
			output_tokens: 0,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function writeLine(
	child: ChildProcessWithoutNullStreams,
	value: unknown,
): Promise<void> {
	return new Promise((resolveWrite, rejectWrite) => {
		const stdin = child.stdin;
		if (!stdin.writable || stdin.destroyed || stdin.writableEnded) {
			rejectWrite(new Error("Meat bridge stdin is closed"));
			return;
		}
		stdin.write(`${JSON.stringify(value)}\n`, (error) => {
			if (error) rejectWrite(asError(error));
			else resolveWrite();
		});
	});
}

function parseBridgeEvent(line: string): BridgeEvent {
	let parsed: Partial<BridgeEvent>;
	try {
		parsed = JSON.parse(line) as Partial<BridgeEvent>;
	} catch (error) {
		throw new Error("Meat bridge sent invalid JSON", { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string")
		throw new Error("Meat bridge sent an invalid event");
	return parsed as BridgeEvent;
}

async function terminateChild(
	child: ChildProcessWithoutNullStreams,
	closed: Promise<void>,
): Promise<void> {
	if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
	if (child.exitCode !== null || child.signalCode !== null) {
		await Promise.race([closed, delay(250)]);
		return;
	}
	child.kill("SIGTERM");
	if (await closesWithin(closed, 750)) return;
	child.kill("SIGKILL");
	await Promise.race([closed, delay(1_000)]);
}

async function closesWithin(
	closed: Promise<void>,
	milliseconds: number,
): Promise<boolean> {
	return Promise.race([
		closed.then(() => true),
		delay(milliseconds).then(() => false),
	]);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => {
		const timer = setTimeout(resolveDelay, milliseconds);
		timer.unref();
	});
}

function cancelledError(): Error {
	return new Error("Meat run cancelled");
}
function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function resolveBridgeCommand(): { file: string; args: string[]; cwd: string } {
	const extensionDir = dirname(fileURLToPath(import.meta.url));
	const packageRoot = resolve(extensionDir, "../..");
	const configured = process.env.PI_MEAT_BRIDGE;
	if (configured) return { file: configured, args: [], cwd: packageRoot };

	const executable =
		process.platform === "win32" ? "pi-meat-bridge.exe" : "pi-meat-bridge";
	const bundled = join(packageRoot, "bin", executable);
	try {
		accessSync(bundled, constants.X_OK);
		return { file: bundled, args: [], cwd: packageRoot };
	} catch {
		return { file: "go", args: ["run", "."], cwd: join(packageRoot, "bridge") };
	}
}
