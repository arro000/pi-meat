import assert from "node:assert/strict";
import test from "node:test";
import {
	providerSessionHeaders,
	type AttributedModel,
	withProviderSessionHeaders,
} from "../extensions/pi-meat/attribution.ts";

const opencode: AttributedModel = {
	provider: "opencode",
	baseUrl: "https://opencode.ai/zen/v1",
};

test("adds opencode session headers so nested calls are not rejected", () => {
	assert.deepEqual(providerSessionHeaders(opencode, "session-1"), {
		"x-opencode-session": "session-1",
		"x-opencode-client": "pi",
	});
	assert.deepEqual(
		providerSessionHeaders(
			{ provider: "custom", baseUrl: "https://opencode.ai/zen/v1" },
			"session-2",
		),
		{ "x-opencode-session": "session-2", "x-opencode-client": "pi" },
	);
	assert.deepEqual(
		providerSessionHeaders(
			{ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/v1" },
			"session-3",
		),
		{ "x-opencode-session": "session-3", "x-opencode-client": "pi" },
	);
});

test("leaves other providers untouched", () => {
	const anthropic: AttributedModel = {
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
	};
	assert.equal(providerSessionHeaders(anthropic, "session-1"), undefined);
	assert.equal(providerSessionHeaders(opencode, undefined), undefined);
	assert.equal(providerSessionHeaders(opencode, ""), undefined);
	assert.equal(
		providerSessionHeaders(
			{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
			"session-1",
		),
		undefined,
	);
	assert.equal(
		providerSessionHeaders(
			{ provider: "custom", baseUrl: "https://opencode.ai.evil.example/v1" },
			"session-1",
		),
		undefined,
	);
	assert.equal(
		providerSessionHeaders({ provider: "custom" }, "session-1"),
		undefined,
	);
	assert.equal(
		providerSessionHeaders({ provider: "custom", baseUrl: "not a url" }, "s"),
		undefined,
	);
});

test("keeps resolved credential headers and overrides collisions", () => {
	const merged = withProviderSessionHeaders(
		opencode,
		{ authorization: "Bearer token" },
		"session-9",
	);
	assert.deepEqual(merged, {
		authorization: "Bearer token",
		"x-opencode-session": "session-9",
		"x-opencode-client": "pi",
	});

	const untouched = withProviderSessionHeaders(
		{ provider: "anthropic", baseUrl: "https://api.anthropic.com" },
		{ authorization: "Bearer token" },
		"session-9",
	);
	assert.deepEqual(untouched, { authorization: "Bearer token" });
	assert.equal(
		withProviderSessionHeaders(opencode, undefined, undefined),
		undefined,
	);
});
