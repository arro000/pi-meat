import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runBridge } from "./bridge.ts";
import {
	artifactPaths,
	artifactRoot,
	type ArtifactPaths,
	persistArtifacts,
	readCache,
	secureCacheTree,
} from "./cache.ts";
import {
	PROTOCOL_VERSION,
	toPiContext,
	type GenerateRequest,
	type MeatResult,
} from "./protocol.ts";

export const CACHE_VERSION = `bridge-${PROTOCOL_VERSION}-diff-only-v2`;

export type MeatModel = NonNullable<ExtensionContext["model"]>;

export interface AbridgeTarget {
	/** `provider/model` without the thinking level. */
	modelLabel: string;
	thinkingLevel: ModelThinkingLevel;
	/** `provider/model · thinking:<level>`, persisted with the artifact. */
	label: string;
	key: string;
	cacheRoot: string;
}

export function meatModelLabel(model: MeatModel): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Content-addressed abridgement target. Foreground `/meat` runs and background
 * pre-processing must derive the same key, otherwise warmed artifacts are never
 * read back and every run pays for a fresh model call.
 */
export function abridgeTarget(
	diff: string,
	model: MeatModel,
	thinkingLevel: ModelThinkingLevel,
): AbridgeTarget {
	const modelLabel = meatModelLabel(model);
	const key = createHash("sha256")
		.update(CACHE_VERSION)
		.update("\0")
		.update(modelLabel)
		.update("\0")
		.update(thinkingLevel)
		.update("\0")
		.update(diff)
		.digest("hex");
	return {
		modelLabel,
		thinkingLevel,
		label: `${modelLabel} · thinking:${thinkingLevel}`,
		key,
		cacheRoot: artifactRoot(key),
	};
}

export async function readAbridged(
	target: AbridgeTarget,
): Promise<{ result: MeatResult; paths: ArtifactPaths } | undefined> {
	await secureCacheTree(dirname(target.cacheRoot));
	return readCache(target.cacheRoot);
}

export interface GenerateAbridgedOptions {
	ctx: ExtensionContext;
	model: MeatModel;
	target: AbridgeTarget;
	diff: string;
	source: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

/** Abridges one diff through the Go bridge and atomically publishes it. */
export async function generateAbridged(
	options: GenerateAbridgedOptions,
): Promise<{ result: MeatResult; paths: ArtifactPaths }> {
	const { ctx, model, target, diff, source, signal, onProgress } = options;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	await secureCacheTree(dirname(target.cacheRoot));

	const nestedSessionId = randomUUID();
	const result = await runBridge({
		diff,
		signal,
		onProgress,
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
					reasoning:
						target.thinkingLevel === "off" ? undefined : target.thinkingLevel,
					cacheRetention: "short",
					sessionId: nestedSessionId,
				},
			);
			if (response.stopReason === "error")
				throw new Error(response.errorMessage ?? "Pi model call failed");
			if (response.stopReason === "aborted")
				throw new Error("Meat model call cancelled");
			return response;
		},
	});

	const paths = artifactPaths(target.cacheRoot, randomUUID());
	await persistArtifacts(paths, result, diff, {
		source,
		model: target.label,
	});
	return { result, paths };
}
