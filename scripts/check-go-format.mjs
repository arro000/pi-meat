import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function goFiles(path) {
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
		const child = join(path, entry.name);
		if (entry.isDirectory()) return goFiles(child);
		return entry.isFile() && entry.name.endsWith(".go") ? [child] : [];
	});
}

const files = goFiles("bridge");
const result = spawnSync("gofmt", ["-l", ...files], { encoding: "utf8" });
if (result.error) throw result.error;
if (result.status !== 0) {
	process.stderr.write(result.stderr || "gofmt failed\n");
	process.exitCode = result.status ?? 1;
} else if (result.stdout.trim()) {
	process.stderr.write(`Go files need formatting:\n${result.stdout}`);
	process.exitCode = 1;
}
