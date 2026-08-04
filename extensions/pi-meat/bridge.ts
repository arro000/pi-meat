import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fromPiResponse,
	PROTOCOL_VERSION,
	type BridgeEvent,
	type GenerateRequest,
	type MeatResult,
} from "./protocol.ts";

const MAX_BRIDGE_LINE_BYTES = 32 * 1024 * 1024;
const MAX_START_REQUEST_BYTES = 31 * 1024 * 1024;
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const SAFE_ENVIRONMENT_KEYS = new Set([
	"APPDATA",
	"COMSPEC",
	"GOCACHE",
	"GOENV",
	"GOMODCACHE",
	"GOPATH",
	"GOROOT",
	"GOTOOLCHAIN",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOCALAPPDATA",
	"PATH",
	"PATHEXT",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"XDG_CACHE_HOME",
]);

export interface RunBridgeOptions {
	diff: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onGenerate: (request: GenerateRequest) => Promise<AssistantMessage>;
}

export async function runBridge(
	options: RunBridgeOptions,
): Promise<MeatResult> {
	if (options.signal?.aborted) throw new Error("Meat run cancelled");
	if (Buffer.byteLength(options.diff, "utf8") > MAX_DIFF_BYTES)
		throw new Error("Selected diff exceeds 16 MiB safety limit");
	const startRequest = {
		type: "abridge",
		protocol_version: PROTOCOL_VERSION,
		repo_root: "",
		diff: options.diff,
	};
	if (
		Buffer.byteLength(JSON.stringify(startRequest), "utf8") >
		MAX_START_REQUEST_BYTES
	)
		throw new Error("Serialized bridge request exceeds 31 MiB safety limit");
	const command = resolveBridgeCommand();
	const child = spawn(command.file, command.args, {
		cwd: command.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: bridgeEnvironment(process.env),
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
			void writeLine(child, startRequest).catch((error) =>
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
	let ready = false;
	let expectedGenerateID = 1;
	for await (const line of readBoundedLines(child.stdout)) {
		if (isSettled()) return;
		if (!line.trim()) continue;
		const event = parseBridgeEvent(line);
		if (event.type === "ready") {
			if (ready) throw new Error("Meat bridge sent duplicate ready event");
			if (event.protocol_version !== PROTOCOL_VERSION)
				throw new Error(
					`Meat bridge protocol mismatch: expected ${PROTOCOL_VERSION}, received ${event.protocol_version}`,
				);
			ready = true;
			continue;
		}
		if (!ready) throw new Error("Meat bridge sent data before ready event");
		if (event.type === "progress") {
			options.onProgress?.(event.message);
			continue;
		}
		if (event.type === "generate") {
			if (event.id !== expectedGenerateID)
				throw new Error(
					`Meat bridge generate id out of order: expected ${expectedGenerateID}, received ${event.id}`,
				);
			expectedGenerateID++;
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
			inputTokens: event.input_tokens ?? 0,
			outputTokens: event.output_tokens ?? 0,
		});
		return;
	}
}

async function* readBoundedLines(
	input: Readable,
	maxBytes = MAX_BRIDGE_LINE_BYTES,
): AsyncGenerator<string> {
	let parts: Buffer[] = [];
	let length = 0;
	for await (const value of input) {
		let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		while (chunk.length > 0) {
			const newline = chunk.indexOf(0x0a);
			const end = newline < 0 ? chunk.length : newline;
			const part = chunk.subarray(0, end);
			length += part.length;
			if (length > maxBytes)
				throw new Error("Meat bridge event exceeds 32 MiB limit");
			if (part.length > 0) parts.push(part);
			if (newline < 0) break;
			let line = Buffer.concat(parts, length);
			if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
			yield line.toString("utf8");
			parts = [];
			length = 0;
			chunk = chunk.subarray(newline + 1);
		}
	}
	if (length > 0) yield Buffer.concat(parts, length).toString("utf8");
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
	if (Buffer.byteLength(line, "utf8") > MAX_BRIDGE_LINE_BYTES)
		throw new Error("Meat bridge event exceeds 32 MiB limit");
	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch (error) {
		throw new Error("Meat bridge sent invalid JSON", { cause: error });
	}
	if (!isRecord(parsed) || typeof parsed.type !== "string")
		throw new Error("Meat bridge sent an invalid event");
	switch (parsed.type) {
		case "ready":
			if (isReadyEvent(parsed)) return parsed as unknown as BridgeEvent;
			break;
		case "progress":
		case "error":
			if (isMessageEvent(parsed)) return parsed as unknown as BridgeEvent;
			break;
		case "generate":
			if (isGenerateEvent(parsed)) return parsed as unknown as BridgeEvent;
			break;
		case "result":
			if (isResultEvent(parsed)) return parsed as unknown as BridgeEvent;
			break;
		default:
			throw new Error(`Meat bridge sent unknown event type: ${parsed.type}`);
	}
	throw new Error(`Meat bridge sent invalid ${parsed.type} event`);
}

function bridgeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const normalized = key.toUpperCase();
		if (SAFE_ENVIRONMENT_KEYS.has(normalized) || normalized.startsWith("LC_"))
			environment[key] = value;
	}
	return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
	return value === undefined || isNonNegativeInteger(value);
}

function isReadyEvent(event: Record<string, unknown>): boolean {
	return isNonNegativeInteger(event.protocol_version);
}

function isMessageEvent(event: Record<string, unknown>): boolean {
	return typeof event.message === "string";
}

function isGenerateEvent(event: Record<string, unknown>): boolean {
	return (
		isNonNegativeInteger(event.id) &&
		typeof event.system === "string" &&
		isWireMessages(event.messages) &&
		isWireTools(event.tools)
	);
}

function isResultEvent(event: Record<string, unknown>): boolean {
	return (
		typeof event.summary === "string" &&
		typeof event.smart_diff === "string" &&
		isOptionalNonNegativeInteger(event.input_tokens) &&
		isOptionalNonNegativeInteger(event.output_tokens)
	);
}

function isWireMessages(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(message) =>
				isRecord(message) &&
				(message.role === "user" || message.role === "assistant") &&
				Array.isArray(message.content) &&
				message.content.every(isWireBlock),
		)
	);
}

function isWireBlock(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "text":
			return typeof value.text === "string";
		case "tool_use":
			return (
				typeof value.id === "string" &&
				typeof value.tool_name === "string" &&
				isRecord(value.tool_input)
			);
		case "tool_result":
			return (
				typeof value.tool_use_id === "string" &&
				typeof value.tool_result === "string" &&
				(value.tool_error === undefined ||
					typeof value.tool_error === "boolean")
			);
		case "provider_state":
			return (
				typeof value.provider === "string" &&
				isRecord(value.provider_data) &&
				value.provider_data.role === "assistant" &&
				Array.isArray(value.provider_data.content) &&
				value.provider_data.content.every(
					(part) => isRecord(part) && typeof part.type === "string",
				)
			);
		default:
			return false;
	}
}

function isWireTools(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(tool) =>
				isRecord(tool) &&
				typeof tool.name === "string" &&
				typeof tool.description === "string" &&
				isRecord(tool.input_schema),
		)
	);
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
	if (configured) {
		const extension = extname(configured).toLowerCase();
		if ([".js", ".cjs", ".mjs"].includes(extension))
			return { file: process.execPath, args: [configured], cwd: packageRoot };
		return { file: configured, args: [], cwd: packageRoot };
	}

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
