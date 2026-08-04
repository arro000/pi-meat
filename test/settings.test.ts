import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	loadMeatSettings,
	resolveMeatModel,
} from "../extensions/pi-meat/settings.ts";

test("loads validated settings and treats missing file as defaults", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-settings-"));
	const path = join(directory, "settings.json");
	const previous = process.env.PI_MEAT_SETTINGS;
	process.env.PI_MEAT_SETTINGS = path;
	try {
		assert.deepEqual(await loadMeatSettings(), {});
		await writeFile(path, '{"defaultModel":"provider/model"}\n');
		assert.deepEqual(await loadMeatSettings(), {
			defaultModel: "provider/model",
		});
	} finally {
		if (previous === undefined) delete process.env.PI_MEAT_SETTINGS;
		else process.env.PI_MEAT_SETTINGS = previous;
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects unavailable configured model instead of silently switching provider", async () => {
	const ctx = {
		modelRegistry: { getAvailable: () => [] },
		model: { provider: "other", id: "active" },
	} as unknown as ExtensionContext;
	await assert.rejects(
		resolveMeatModel(ctx, "saved/model"),
		/Configured pi-meat model is unavailable/,
	);
});

test("rejects malformed settings instead of silently switching model", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-meat-settings-invalid-"));
	const path = join(directory, "settings.json");
	const previous = process.env.PI_MEAT_SETTINGS;
	process.env.PI_MEAT_SETTINGS = path;
	try {
		await writeFile(path, "{broken");
		await assert.rejects(loadMeatSettings(), /Invalid pi-meat settings JSON/);
		await writeFile(path, '{"defaultModel":42}\n');
		await assert.rejects(loadMeatSettings(), /defaultModel must be a string/);
	} finally {
		if (previous === undefined) delete process.env.PI_MEAT_SETTINGS;
		else process.env.PI_MEAT_SETTINGS = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
