import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd,
	});
	if (result.code !== 0)
		throw new Error("pi-meat must run inside a Git repository");
	return result.stdout.trim();
}

export async function readGitDiff(
	pi: ExtensionAPI,
	cwd: string,
	source: string,
): Promise<{ diff: string; source: string }> {
	if (source.startsWith("-"))
		throw new Error("Git source cannot start with '-'");
	let args: string[];
	if (source === "staged")
		args = ["diff", "--staged", "--no-ext-diff", "--no-color"];
	else if (source === "worktree")
		args = ["diff", "--no-ext-diff", "--no-color"];
	else if (source === "all")
		args = ["diff", "HEAD", "--no-ext-diff", "--no-color"];
	else if (source.includes(".."))
		args = ["diff", "--no-ext-diff", "--no-color", source];
	else
		args = [
			"show",
			"--format=fuller",
			"-m",
			"--first-parent",
			"--no-ext-diff",
			"--no-color",
			source,
		];
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0)
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	return { diff: result.stdout, source };
}

/** Resolves the commit currently checked out, or undefined outside a repository. */
export async function headRevision(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string | undefined> {
	const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd });
	if (result.code !== 0) return undefined;
	const revision = result.stdout.trim();
	return /^[0-9a-f]{40}$/.test(revision) ? revision : undefined;
}
