import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

mkdirSync("bin", { recursive: true });
const executable =
	process.platform === "win32" ? "pi-meat-bridge.exe" : "pi-meat-bridge";
const result = spawnSync(
	"go",
	["-C", "bridge", "build", "-o", resolve("bin", executable), "."],
	{
		stdio: "inherit",
	},
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
