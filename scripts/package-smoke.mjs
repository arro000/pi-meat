import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let npm = { file: "npm", args: [] };
if (process.env.npm_execpath)
	npm = { file: process.execPath, args: [process.env.npm_execpath] };
else if (process.platform === "win32") npm = { file: "npm.cmd", args: [] };
const root = fileURLToPath(new URL("..", import.meta.url));
const npmEnvironment = { ...process.env, npm_config_dry_run: "false" };
let archive;
let temporary;

try {
	const packed = spawnSync(
		npm.file,
		[...npm.args, "pack", "--json", "--ignore-scripts"],
		{
			cwd: root,
			encoding: "utf8",
			env: npmEnvironment,
		},
	);
	if (packed.error) throw packed.error;
	if (packed.status !== 0) throw new Error(packed.stderr || "npm pack failed");
	const report = JSON.parse(packed.stdout);
	const [packageReport] = Array.isArray(report) ? report : Object.values(report);
	if (!packageReport?.filename) throw new Error("npm pack returned no package");
	archive = join(root, packageReport.filename);
	temporary = mkdtempSync(join(tmpdir(), "pi-meat-package-"));
	writeFileSync(
		join(temporary, "package.json"),
		'{"name":"pi-meat-package-smoke","private":true,"version":"0.0.0"}\n',
	);
	const installed = spawnSync(
		npm.file,
		[
			...npm.args,
			"install",
			"--ignore-scripts",
			"--omit=peer",
			"--no-package-lock",
			archive,
		],
		{ cwd: temporary, encoding: "utf8", env: npmEnvironment },
	);
	if (installed.error) throw installed.error;
	if (installed.status !== 0)
		throw new Error(installed.stderr || "tarball install failed");
	const packageRoot = join(temporary, "node_modules", "@arro000", "pi-meat");
	const manifest = JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	);
	if (manifest.name !== "@arro000/pi-meat")
		throw new Error("wrong package name");
	if (manifest.main !== undefined)
		throw new Error("Pi-only package must not declare main");
	if (manifest.dependencies !== undefined)
		throw new Error("Pi-only package must not declare runtime dependencies");
	const extension = manifest.pi?.extensions?.[0];
	if (
		typeof extension !== "string" ||
		!existsSync(join(packageRoot, extension))
	)
		throw new Error("packaged Pi extension entry is missing");
	for (const file of [
		"bridge/main.go",
		"LICENSE",
		"SECURITY.md",
		"assets/pi-meat-preview.png",
		"scripts/generate-preview.mjs",
	]) {
		if (!existsSync(join(packageRoot, file)))
			throw new Error(`missing ${file}`);
	}
	process.stdout.write(
		`${manifest.name}@${manifest.version} exact-package smoke passed\n`,
	);
} finally {
	if (temporary) rmSync(temporary, { recursive: true, force: true });
	if (archive) rmSync(archive, { force: true });
}
