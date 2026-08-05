import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	SelectList,
	SettingsList,
	Text,
	type SelectItem,
	type SettingItem,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal.ts";

type MeatStartupMode = "default" | "on-demand";

export interface MeatSettings {
	defaultModel?: string;
	thinkingLevel?: ModelThinkingLevel;
	startupMode?: MeatStartupMode;
}

const THINKING_LEVELS: ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const settingsPath = () =>
	process.env.PI_MEAT_SETTINGS ??
	join(homedir(), ".pi", "agent", "pi-meat.json");

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export async function loadMeatSettings(): Promise<MeatSettings> {
	let source: string;
	try {
		source = await readFile(settingsPath(), "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return {};
		throw new Error(
			`Could not read pi-meat settings: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	let value: MeatSettings;
	try {
		value = JSON.parse(source) as MeatSettings;
	} catch (error) {
		throw new Error("Invalid pi-meat settings JSON", { cause: error });
	}
	if (typeof value !== "object" || value === null)
		throw new Error("Invalid pi-meat settings: expected object");
	if (
		value.defaultModel !== undefined &&
		typeof value.defaultModel !== "string"
	)
		throw new Error("Invalid pi-meat settings: defaultModel must be a string");
	if (
		value.thinkingLevel !== undefined &&
		!THINKING_LEVELS.includes(value.thinkingLevel)
	)
		throw new Error(
			"Invalid pi-meat settings: thinkingLevel must be a supported level",
		);
	if (
		value.startupMode !== undefined &&
		value.startupMode !== "default" &&
		value.startupMode !== "on-demand"
	)
		throw new Error(
			"Invalid pi-meat settings: startupMode must be default or on-demand",
		);
	return {
		...(value.defaultModel ? { defaultModel: value.defaultModel } : {}),
		...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel } : {}),
		...(value.startupMode ? { startupMode: value.startupMode } : {}),
	};
}

async function saveMeatSettings(settings: MeatSettings): Promise<void> {
	const path = settingsPath();
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, path);
}

export async function resolveMeatModel(
	ctx: ExtensionContext,
	configured: string | undefined,
) {
	const available = ctx.modelRegistry.getAvailable().filter(isSafeModel);
	if (configured) {
		const selected = available.find(
			(model) => `${model.provider}/${model.id}` === configured,
		);
		if (selected) return selected;
		throw new Error(
			`Configured pi-meat model is unavailable: ${configured}. Open /meat-settings to choose another.`,
		);
	}
	return ctx.model &&
		available.some(
			(model) =>
				model.provider === ctx.model?.provider && model.id === ctx.model?.id,
		)
		? ctx.model
		: undefined;
}

function isSafeModel(model: { provider: string; id: string }): boolean {
	const key = `${model.provider}/${model.id}`;
	return sanitizeTerminalText(key) === key;
}

export async function openMeatSettings(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/meat settings requires Pi TUI", "error");
		return;
	}

	const settings = await loadMeatSettings();
	const available = [...ctx.modelRegistry.getAvailable()]
		.filter(isSafeModel)
		.sort((a, b) =>
			`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
		);
	if (available.length === 0) {
		ctx.ui.notify("No authenticated Pi models available", "error");
		return;
	}
	let current =
		settings.defaultModel &&
		available.some(
			(model) => `${model.provider}/${model.id}` === settings.defaultModel,
		)
			? settings.defaultModel
			: undefined;
	if (
		!current &&
		ctx.model &&
		available.some(
			(model) =>
				model.provider === ctx.model?.provider && model.id === ctx.model?.id,
		)
	) {
		current = `${ctx.model.provider}/${ctx.model.id}`;
	}
	if (!current) {
		const first = available[0];
		if (!first) return;
		current = `${first.provider}/${first.id}`;
	}

	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		let pendingSave: Promise<void> = Promise.resolve();
		const selectedModel = () =>
			available.find((model) => `${model.provider}/${model.id}` === current) ??
			available[0];
		const selectedThinkingLevel = () => {
			const model = selectedModel();
			return model
				? clampThinkingLevel(
						model,
						settings.thinkingLevel ?? ctx.thinkingLevel ?? "medium",
					)
				: "off";
		};
		const supportedThinkingLevels = () => {
			const model = selectedModel();
			return model
				? getSupportedThinkingLevels(model)
				: (["off"] as ModelThinkingLevel[]);
		};
		const modelItems: SelectItem[] = available.map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: sanitizeTerminalText(`${model.provider}/${model.id}`),
			description: sanitizeTerminalText(model.name),
		}));
		const items: SettingItem[] = [
			{
				id: "defaultModel",
				label: "Meat model",
				currentValue: current ?? "",
				description: "Model used by Meat. Pi active model remains unchanged.",
				submenu: (value, selectDone) => {
					const picker = new SelectList(
						modelItems,
						Math.min(modelItems.length, 12),
						getSelectListTheme(),
					);
					const index = modelItems.findIndex((item) => item.value === value);
					if (index >= 0) picker.setSelectedIndex(index);
					picker.onSelect = (item) => selectDone(item.value);
					picker.onCancel = () => selectDone();
					return picker;
				},
			},
			{
				id: "thinkingLevel",
				label: "Meat thinking",
				currentValue: selectedThinkingLevel(),
				description: "Reasoning depth used by Meat only.",
				submenu: (value, selectDone) => {
					const thinkingItems: SelectItem[] = supportedThinkingLevels().map(
						(level) => ({ value: level, label: level }),
					);
					const picker = new SelectList(
						thinkingItems,
						thinkingItems.length,
						getSelectListTheme(),
					);
					const index = thinkingItems.findIndex((item) => item.value === value);
					if (index >= 0) picker.setSelectedIndex(index);
					picker.onSelect = (item) => selectDone(item.value);
					picker.onCancel = () => selectDone();
					return picker;
				},
			},
			{
				id: "startupMode",
				label: "Meat startup",
				currentValue: settings.startupMode ?? "default",
				description: "Start automatically or only from the reading view.",
				submenu: (value, selectDone) => {
					const startupItems: SelectItem[] = [
						{ value: "default", label: "default" },
						{ value: "on-demand", label: "on-demand" },
					];
					const picker = new SelectList(
						startupItems,
						startupItems.length,
						getSelectListTheme(),
					);
					picker.setSelectedIndex(value === "on-demand" ? 1 : 0);
					picker.onSelect = (item) => selectDone(item.value);
					picker.onCancel = () => selectDone();
					return picker;
				},
			},
		];
		const list = new SettingsList(
			items,
			7,
			getSettingsListTheme(),
			(id, value) => {
				if (id === "defaultModel") {
					settings.defaultModel = value;
					current = value;
				} else if (id === "thinkingLevel")
					settings.thinkingLevel = value as ModelThinkingLevel;
				else settings.startupMode = value as MeatStartupMode;
				const snapshot = { ...settings };
				let name = "startup";
				if (id === "defaultModel") name = "model";
				else if (id === "thinkingLevel") name = "thinking";
				const status = `${name}: ${value}`;
				pendingSave = pendingSave
					.then(() => saveMeatSettings(snapshot))
					.then(
						() =>
							ctx.ui.setStatus("pi-meat", `🥩 ${sanitizeTerminalText(status)}`),
						(error) =>
							ctx.ui.notify(
								`Could not save settings: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
								"error",
							),
					);
			},
			() => {
				void pendingSave.finally(() => done(undefined));
			},
		);
		const container = new Container();
		container.addChild(
			new Text(theme.fg("accent", theme.bold("🥩 pi-meat settings")), 1, 1),
		);
		container.addChild(
			new Text(theme.fg("dim", "Enter changes setting · Esc closes"), 1, 0),
		);
		container.addChild(list);
		return {
			render: (width: number) => container.render(width),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => container.invalidate(),
		};
	});
}
