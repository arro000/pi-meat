import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runBridge } from "./bridge.ts";
import { toPiContext, type GenerateRequest, type MeatResult, PROTOCOL_VERSION } from "./protocol.ts";
import { MeatDiffViewer, type ViewerAction } from "./viewer.ts";

const BRAND = "🥩 pi-meat";
const CACHE_VERSION = `bridge-${PROTOCOL_VERSION}`;

interface ArtifactEntry {
	summary: string;
	source: string;
	model: string;
	readingPath: string;
	originalPath: string;
	inputTokens: number;
	outputTokens: number;
	cached: boolean;
}

export default function piMeat(pi: ExtensionAPI) {
	pi.registerEntryRenderer("pi-meat-result", (entry, _options, theme) => {
		const data = entry.data as ArtifactEntry;
		return new Text(
			`${theme.fg("accent", theme.bold(BRAND))} ${theme.fg("muted", data.cached ? "cached" : `${data.inputTokens + data.outputTokens} tokens`)}\n` +
			`${theme.fg("text", data.summary)}\n${theme.fg("dim", `${data.source} · ${data.model} · ${data.readingPath}`)}`,
			1,
			0,
		);
	});

	pi.registerCommand("meat", {
		description: "Open a navigable Meat reading diff using your active Pi subscription",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("pi-meat currently requires Pi's interactive TUI", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("Select and authenticate a model in Pi first", "error");
				return;
			}

			try {
				const parsedArgs = parseArgs(args);
				const repoRoot = await gitRoot(pi, ctx);
				const { diff, source } = await readGitDiff(pi, repoRoot, parsedArgs.source);
				if (!diff.trim()) throw new Error(`No changes found for ${source}`);

				const model = ctx.model;
				const modelLabel = `${model.provider}/${model.id}`;
				const key = createHash("sha256").update(CACHE_VERSION).update("\0").update(modelLabel).update("\0").update(diff).digest("hex");
				const paths = artifactPaths(key);
				let result = parsedArgs.fresh ? undefined : await readCache(paths.result);
				const cached = result !== undefined;

				if (!result) {
					const computed = await runWithLoader(ctx, source, modelLabel, async (signal, progress) => {
						const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
						if (!auth.ok) throw new Error(auth.error);

						const nestedSessionId = randomUUID();
						return runBridge({
							repoRoot,
							diff,
							signal,
							onProgress: progress,
							onGenerate: async (request: GenerateRequest) => {
								const meatContext = toPiContext(request);
								const response = await completeSimple(
									model,
									{ systemPrompt: request.system, ...meatContext },
									{
										apiKey: auth.apiKey,
										headers: auth.headers,
										env: auth.env,
										signal,
										reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
										cacheRetention: "short",
										sessionId: nestedSessionId,
									},
								);
								if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Pi model call failed");
								if (response.stopReason === "aborted") throw new Error("Meat model call cancelled");
								return response;
							},
						});
					});
					if (!computed) return;
					result = computed;
				}

				await persistArtifacts(paths, result, diff, { source, model: modelLabel });
				const artifact: ArtifactEntry = {
					summary: result.summary,
					source,
					model: modelLabel,
					readingPath: paths.reading,
					originalPath: paths.original,
					inputTokens: result.inputTokens,
					outputTokens: result.outputTokens,
					cached,
				};
				pi.appendEntry("pi-meat-result", artifact);

				const action = await ctx.ui.custom<ViewerAction>((tui, theme, _keybindings, done) => {
					const viewer = new MeatDiffViewer(
						theme, result!.summary, diff, result!.smartDiff, modelLabel,
						() => Math.max(8, tui.terminal.rows - 9), done,
					);
					return {
						render: (width) => viewer.render(width),
						handleInput: (data) => { viewer.handleInput(data); tui.requestRender(); },
						invalidate: () => viewer.invalidate(),
						dispose: () => viewer.dispose(),
					};
				});

				if (action === "review") {
					pi.sendUserMessage(
						`Review the ${source} changes. Meat's reading diff is at ${paths.reading}; the immutable original diff is at ${paths.original}. Start from the reading diff for intent, but verify every finding against the original diff and repository source. Focus on correctness, regressions, security, and architectural consequences rather than style.`,
					);
				}
			} catch (error) {
				ctx.ui.setStatus("pi-meat", undefined);
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

async function runWithLoader(
	ctx: ExtensionCommandContext,
	source: string,
	model: string,
	run: (signal: AbortSignal, progress: (message: string) => void) => Promise<MeatResult>,
): Promise<MeatResult | null> {
	const result = await ctx.ui.custom<MeatResult | null>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `${BRAND} · abridging ${source} with ${model}`, { cancellable: true });
		loader.onAbort = () => done(null);
		const progress = (message: string) => ctx.ui.setStatus("pi-meat", `🥩 ${message}`);
		run(loader.signal, progress).then(done).catch((error) => {
			if (!loader.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			done(null);
		});
		return loader;
	});
	ctx.ui.setStatus("pi-meat", undefined);
	return result ?? null;
}

async function gitRoot(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
	if (result.code !== 0) throw new Error("pi-meat must run inside a Git repository");
	return result.stdout.trim();
}

async function readGitDiff(pi: ExtensionAPI, cwd: string, source: string): Promise<{ diff: string; source: string }> {
	let args: string[];
	if (source === "staged") args = ["diff", "--staged", "--no-ext-diff", "--no-color"];
	else if (source === "worktree") args = ["diff", "--no-ext-diff", "--no-color"];
	else if (source === "all") args = ["diff", "HEAD", "--no-ext-diff", "--no-color"];
	else if (source.includes("..")) args = ["diff", "--no-ext-diff", "--no-color", source];
	else args = ["show", "--format=fuller", "-m", "--first-parent", "--no-ext-diff", "--no-color", source];
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	return { diff: result.stdout, source };
}

function parseArgs(raw: string): { source: string; fresh: boolean } {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const freshIndex = tokens.indexOf("--fresh");
	const fresh = freshIndex >= 0;
	if (fresh) tokens.splice(freshIndex, 1);
	if (tokens.length > 1) throw new Error("Usage: /meat [HEAD|revision|range|staged|worktree|all] [--fresh]");
	const value = tokens[0] ?? "HEAD";
	return { source: value === "w" ? "worktree" : value, fresh };
}

function artifactPaths(key: string) {
	const root = join(process.env.PI_MEAT_CACHE ?? join(homedir(), ".pi", "agent", "cache", "pi-meat"), key);
	return { root, result: join(root, "result.json"), reading: join(root, "reading.diff"), original: join(root, "original.diff") };
}

async function readCache(path: string): Promise<MeatResult | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as MeatResult;
		return typeof parsed.smartDiff === "string" && typeof parsed.summary === "string" ? parsed : undefined;
	} catch { return undefined; }
}

async function persistArtifacts(
	paths: ReturnType<typeof artifactPaths>,
	result: MeatResult,
	original: string,
	metadata: { source: string; model: string },
): Promise<void> {
	await mkdir(paths.root, { recursive: true });
	await Promise.all([
		writeFile(paths.result, `${JSON.stringify({ ...result, ...metadata }, null, 2)}\n`, "utf8"),
		writeFile(paths.reading, result.smartDiff, "utf8"),
		writeFile(paths.original, original, "utf8"),
	]);
}
