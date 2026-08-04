import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../internal/diff.ts";

test("parses files and changed-line counts", () => {
	const parsed = parseUnifiedDiff(`commit abc\nAuthor: A\n\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1 @@\n+added\n`);
	assert.equal(parsed.files.length, 3);
	assert.equal(parsed.files[0]?.path, "commit");
	assert.equal(parsed.files[1]?.path, "a.ts");
	assert.deepEqual([parsed.files[1]?.added, parsed.files[1]?.removed], [1, 1]);
	assert.deepEqual([parsed.files[2]?.added, parsed.files[2]?.removed], [1, 0]);
});

test("returns an empty structure for empty input", () => {
	assert.deepEqual(parseUnifiedDiff(""), { lines: [], files: [] });
});
