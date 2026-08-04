import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

export interface MeatSettings {
	defaultModel?: string;
}

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
	return value.defaultModel ? { defaultModel: value.defaultModel } : {};
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
	const available = ctx.modelRegistry.getAvailable();
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

export async function openMeatSettings(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/meat settings requires Pi TUI", "error");
		return;
	}

	const settings = await loadMeatSettings();
	const available = [...ctx.modelRegistry.getAvailable()].sort((a, b) =>
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
		const modelItems: SelectItem[] = available.map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: `${model.provider}/${model.id}`,
			description: model.name,
		}));
		const items: SettingItem[] = [
			{
				id: "defaultModel",
				label: "Meat model",
				currentValue: current,
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
		];
		const list = new SettingsList(
			items,
			4,
			getSettingsListTheme(),
			(_id, value) => {
				settings.defaultModel = value;
				const snapshot = { ...settings };
				pendingSave = pendingSave
					.then(() => saveMeatSettings(snapshot))
					.then(
						() => ctx.ui.setStatus("pi-meat", `🥩 model: ${value}`),
						(error) =>
							ctx.ui.notify(
								`Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
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
			new Text(theme.fg("dim", "Enter opens model list · Esc closes"), 1, 0),
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
