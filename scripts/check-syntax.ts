/**
 * check-syntax.ts
 *
 * Fast syntax-only validation for every TypeScript file under `src`, `test`,
 * and `scripts`. Uses TypeScript's `transpileModule` (its syntax/semantic-less
 * transpiler) so no type inference or project resolution is performed — this is
 * intentionally narrower than `tsc --noEmit` (typecheck) and Biome (lint).
 *
 * Why: catches parse errors immediately with zero dependency on the full type
 * graph, and keeps a cheap, dedicated gate distinct from `typecheck` and `lint`.
 *
 * Usage:
 *   bun run scripts/check-syntax.ts        (or `bun run syntax`)
 *
 * Exit codes:
 *   0  ok (no syntax errors)
 *   1  at least one file failed to parse
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "test", "scripts"];

function collectTsFiles(dir: string, acc: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectTsFiles(full, acc);
		} else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
			acc.push(full);
		}
	}
}

const files: string[] = [];
for (const d of DIRS) collectTsFiles(join(ROOT, d), files);

if (files.length === 0) {
	console.error(
		"check-syntax: no TypeScript files found under src/, test/, scripts/.",
	);
	process.exit(1);
}

let failed = false;

for (const file of files) {
	const rel = relative(ROOT, file);
	const sourceText = readFileSync(file, "utf8");
	const out = transpileModule(sourceText, {
		compilerOptions: {
			target: ScriptTarget.ESNext,
			module: ModuleKind.Preserve,
		},
		reportDiagnostics: true,
		fileName: rel,
	});
	const diagnostics = out.diagnostics ?? [];
	// transpileModule reports syntactic diagnostics; keep only errors.
	const errors = diagnostics.filter((d) => d.category === 1 /* Error */);
	if (errors.length > 0) {
		failed = true;
		console.error(`\n\u2717 ${rel}`);
		for (const d of errors) {
			const msg =
				typeof d.messageText === "string"
					? d.messageText
					: d.messageText.messageText;
			console.error(`   TS${d.code}: ${msg}`);
		}
	}
}

if (failed) {
	console.error(`\ncheck-syntax FAILED: ${files.length} file(s) scanned.`);
	process.exit(1);
}
console.log(`ok: syntax valid for ${files.length} file(s).`);
