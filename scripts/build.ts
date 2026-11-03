/**
 * build.ts
 *
 * Bundles the multi-module TypeScript source under `src/` into a single
 * self-contained TypeScript plugin file `dist/opencode-pack-models.ts`.
 *
 * Why: OpenCode supports single-file `.ts` plugins (for example in
 * `.opencode/plugins/` or `~/.config/opencode/plugins/`). Rather than emitting
 * type-stripped JavaScript, this bundler resolves internal modules in
 * topological dependency order, deduplicates external imports, checks for
 * top-level identifier collisions, and verifies the resulting file with
 * TypeScript's parser.
 *
 * Usage:
 *   bun run scripts/build.ts [outFile]   (or `bun run build`)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src/index.ts");
const DEFAULT_OUT = join(ROOT, "dist/opencode-pack-models.ts");

/** Watchers must see complete files, never the truncate/write interval. */
function writeAtomic(path: string, content: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, content, "utf8");
	renameSync(temporary, path);
}

interface ExternalSpecifier {
	imported: string;
	local: string;
	typeOnly: boolean;
}

interface ParsedModule {
	path: string;
	rel: string;
	body: string;
	deps: string[];
	declarations: string[];
}

function collectDeclaredNames(sf: ts.SourceFile): string[] {
	const names: string[] = [];
	for (const stmt of sf.statements) {
		if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
			}
		} else if (
			(ts.isFunctionDeclaration(stmt) ||
				ts.isClassDeclaration(stmt) ||
				ts.isInterfaceDeclaration(stmt) ||
				ts.isTypeAliasDeclaration(stmt) ||
				ts.isEnumDeclaration(stmt)) &&
			stmt.name
		) {
			names.push(stmt.name.text);
		}
	}
	return names;
}

export function buildSingleFile(
	outPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT,
): string {
	const externals = new Map<string, Map<string, ExternalSpecifier>>();
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const modules: ParsedModule[] = [];

	function recordExternal(
		moduleName: string,
		imported: string,
		local: string,
		typeOnly: boolean,
	): void {
		let group = externals.get(moduleName);
		if (!group) {
			group = new Map();
			externals.set(moduleName, group);
		}
		const key = `${imported}:${local}`;
		const existing = group.get(key);
		if (!existing) {
			group.set(key, { imported, local, typeOnly });
		} else if (!typeOnly) {
			existing.typeOnly = false;
		}
	}

	function visit(filePath: string): void {
		if (visited.has(filePath)) return;
		if (visiting.has(filePath)) {
			throw new Error(
				`Circular dependency detected at ${relative(ROOT, filePath)}`,
			);
		}
		visiting.add(filePath);

		const rel = relative(ROOT, filePath).replaceAll("\\", "/");
		const sourceText = readFileSync(filePath, "utf8");
		const sf = ts.createSourceFile(
			rel,
			sourceText,
			ts.ScriptTarget.ESNext,
			true,
			ts.ScriptKind.TS,
		);

		const deps: string[] = [];
		let bodyStart = 0;

		for (const stmt of sf.statements) {
			if (!ts.isImportDeclaration(stmt)) break;
			if (!ts.isStringLiteral(stmt.moduleSpecifier)) {
				throw new Error(`Unsupported import in ${rel}`);
			}
			const spec = stmt.moduleSpecifier.text;
			if (spec.startsWith(".")) {
				const target = resolve(dirname(filePath), spec);
				deps.push(target);
			} else if (stmt.importClause) {
				const clause = stmt.importClause;
				const clauseTypeOnly = clause.isTypeOnly;
				if (clause.name || !clause.namedBindings) {
					throw new Error(
						`Unsupported default or side-effect import from "${spec}" in ${rel}`,
					);
				}
				if (!ts.isNamedImports(clause.namedBindings)) {
					throw new Error(
						`Unsupported namespace import from "${spec}" in ${rel}`,
					);
				}
				for (const el of clause.namedBindings.elements) {
					const imported = el.propertyName?.text ?? el.name.text;
					const local = el.name.text;
					recordExternal(
						spec,
						imported,
						local,
						clauseTypeOnly || el.isTypeOnly,
					);
				}
			}
			bodyStart = stmt.end;
		}

		// Ensure no import declarations appear after non-import statements.
		for (const stmt of sf.statements) {
			if (stmt.pos >= bodyStart && ts.isImportDeclaration(stmt)) {
				throw new Error(
					`Mid-file import declaration in ${rel} cannot be bundled safely`,
				);
			}
		}

		for (const dep of deps) visit(dep);

		visiting.delete(filePath);
		visited.add(filePath);

		modules.push({
			path: filePath,
			rel,
			body: sourceText.slice(bodyStart).trim(),
			deps,
			declarations: collectDeclaredNames(sf),
		});
	}

	visit(ENTRY);

	const seenDecls = new Map<string, string>();
	for (const mod of modules) {
		for (const name of mod.declarations) {
			const prev = seenDecls.get(name);
			if (prev) {
				throw new Error(
					`Top-level identifier collision for "${name}" between ${prev} and ${mod.rel}`,
				);
			}
			seenDecls.set(name, mod.rel);
		}
	}

	const importLines = [...externals.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([moduleName, group]) => {
			const specs = [...group.values()].sort((a, b) =>
				a.imported.localeCompare(b.imported),
			);
			const allTypeOnly = specs.every((s) => s.typeOnly);
			const items = specs.map((s) => {
				const alias =
					s.imported === s.local ? s.imported : `${s.imported} as ${s.local}`;
				return !allTypeOnly && s.typeOnly ? `type ${alias}` : alias;
			});
			const prefix = `import ${allTypeOnly ? "type " : ""}`;
			const singleLine = `${prefix}{ ${items.join(", ")} } from "${moduleName}";`;
			if (singleLine.length <= 80) return singleLine;
			return `${prefix}{\n\t${items.join(",\n\t")},\n} from "${moduleName}";`;
		});

	const sections = modules.map((mod) => `// --- ${mod.rel} ---\n\n${mod.body}`);
	const output = `${importLines.join("\n")}\n\n${sections.join("\n\n")}\n`;

	mkdirSync(dirname(outPath), { recursive: true });
	writeAtomic(outPath, output);
	if (outPath === DEFAULT_OUT) {
		const entry =
			'export * from "./opencode-pack-models.ts";\nexport { default } from "./opencode-pack-models.ts";\n';
		// Use directory entrypoints, not a same-named nested package manifest.
		// The host can otherwise resolve the ancestor package and skip this
		// plugin because the resolved server entrypoint lies outside dist.
		writeAtomic(join(dirname(outPath), "server.ts"), entry);
		writeAtomic(join(dirname(outPath), "index.ts"), entry);
	}

	const configPath = join(ROOT, "tsconfig.json");
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsedConfig = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		ROOT,
	);
	const program = ts.createProgram([outPath], {
		...parsedConfig.options,
		noEmit: true,
	});
	const diagnostics = ts
		.getPreEmitDiagnostics(program)
		.filter((d) => d.category === ts.DiagnosticCategory.Error);
	if (diagnostics.length > 0) {
		const msg = diagnostics
			.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
			.join("\n");
		throw new Error(`Bundled output failed TypeScript validation:\n${msg}`);
	}

	return outPath;
}

if (import.meta.main) {
	const out = buildSingleFile();
	console.log(`ok: built ${relative(ROOT, out)}`);
}
