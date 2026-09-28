import type { ProviderHeaders } from "@earendil-works/pi-ai";

/** Host that identifies opencode-hosted models regardless of provider id. */
const OPENCODE_HOST = "opencode.ai";

/** Provider ids that require opencode session attribution headers. */
const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);

/** Minimal model shape needed for attribution. */
export interface AttributedModel {
	provider: string;
	baseUrl?: string;
}

/**
 * Headers Pi attaches to its own provider requests that a direct provider call
 * must replay.
 *
 * Pi adds `x-opencode-session` and `x-opencode-client` in its request pipeline,
 * so a nested model call that bypasses that pipeline reaches opencode without a
 * session and is rejected with `MissingSessionID`. Meat replays the same pair,
 * using Pi's session id when one is available.
 */
export function providerSessionHeaders(
	model: AttributedModel,
	sessionId: string | undefined,
): ProviderHeaders | undefined {
	if (!sessionId) return undefined;
	if (
		!OPENCODE_PROVIDERS.has(model.provider) &&
		hostnameOf(model.baseUrl) !== OPENCODE_HOST
	)
		return undefined;
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

/** Merges attribution headers over the resolved credentials, if any apply. */
export function withProviderSessionHeaders(
	model: AttributedModel,
	headers: ProviderHeaders | undefined,
	sessionId: string | undefined,
): ProviderHeaders | undefined {
	const attribution = providerSessionHeaders(model, sessionId);
	if (!attribution) return headers;
	return { ...headers, ...attribution };
}

function hostnameOf(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
}
