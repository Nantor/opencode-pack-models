/**
 * check-effect.ts
 *
 * Verifies that the `effect` version used by the installed `@opencode/plugin`
 * is compatible with the `effect` `peerDependencies` range declared by this
 * package.
 *
 * Why: `@opencode/plugin` pins its own `effect` as a regular dependency.
 * At runtime, OpenCode hands plugins a single shared host `effect` instance,
 * and two copies of `effect` do not share fiber / logger / Schema internals.
 * If `@opencode/plugin` is bumped to an `effect` version outside the range we
 * allow as a peer, our plugin can silently break. This script makes that
 * mistake impossible by failing (or loudly warning) at dev/CI time.
 *
 * Policy (no external dependencies):
 *   - HARD FAIL  when the plugin's `effect` does not satisfy our peer range.
 *   - HARD FAIL  on any major or minor bump relative to the peer range's floor.
 *                (Effect minor releases can carry breaking changes too.)
 *   - WARNING    on a patch-only difference (probably safe, but still flagged).
 *                A warning exit code is `2`, so CI can treat it as a failure.
 *
 * Usage:
 *   bun run scripts/check-effect.ts        (or wire into your `check`/`test`)
 *
 * Exit codes:
 *   0  ok (no drift)
 *   1  hard failure (version outside the peer range, or major/minor drift)
 *   2  warning (patch-level drift) — non-fatal locally, but fails `&&` chains in CI
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(p: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(ROOT, p), "utf8")) as Record<
		string,
		unknown
	>;
}

function fail(msg: string): never {
	console.error(`\n\u2717 check-effect FAILED:\n   ${msg}\n`);
	return process.exit(1);
}

let hadWarning = false;

function warn(msg: string): void {
	hadWarning = true;
	console.warn(`\n\u26a0  check-effect warning:\n   ${msg}\n`);
}

/* ------------------------------------------------------------------ */
/* Minimal semver parsing (no external dependency)                     */
/* Supports: exact "1.2.3", "^1.2.3", "~1.2.3", ">=1.2.3", ">1.2.3",  */
/*           "*", and basic "x" wildcard forms.                        */
/* ------------------------------------------------------------------ */

interface SemVer {
	major: number;
	minor: number;
	patch: number;
	prerelease: string[];
}

function parseVersion(v: string): SemVer {
	const cleaned = v.trim().replace(/^v/, "");
	const [core, ...rest] = cleaned.split("-");
	const pre = rest.join("-") ? rest.join("-").split(".") : [];
	const parts = (core ?? "").split(".");
	const num = (s: string | undefined, dflt = 0): number => {
		if (s === undefined || s === "" || s === "x" || s === "X" || s === "*")
			return dflt;
		const n = Number.parseInt(s, 10);
		return Number.isNaN(n) ? dflt : n;
	};
	return {
		major: num(parts[0]),
		minor: num(parts[1]),
		patch: num(parts[2]),
		prerelease: pre,
	};
}

/** srcedesv1-ish compare: returns -1, 0, or 1. `hasPre` marks the LEFT side having prerelease data. */
function compare(a: SemVer, b: SemVer): number {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
	// Pre-release sorts before the same non-prerelease version.
	const aPre = a.prerelease.length > 0;
	const bPre = b.prerelease.length > 0;
	if (!aPre && !bPre) return 0;
	if (aPre && !bPre) return -1;
	if (!aPre && bPre) return 1;
	return 0; // simplified: not distinguishing prerelease identifiers
}

function satisfies(versionStr: string, range: string): boolean {
	const v = parseVersion(versionStr);

	// A range can be an OR-list of comparators separated by "||".
	return range.split("||").some((alternative) => {
		const alt = alternative.trim();
		if (!alt || alt === "*" || alt === "x" || alt === "X") return true;

		// Handle AND-space separated (e.g. ">=1.2.0 <2.0.0") by checking all.
		const comparators = alt.split(/\s+/).filter(Boolean);
		return comparators.every((cmp) => satisfiesOne(v, cmp));
	});
}

function satisfiesOne(v: SemVer, cmp: string): boolean {
	if (cmp === "*" || cmp === "x" || cmp === "X") return true;

	const tilde = cmp.startsWith("~");
	const caret = cmp.startsWith("^");
	const ge = cmp.startsWith(">=");
	const gt = cmp.startsWith(">");
	const le = cmp.startsWith("<=");
	const lt = cmp.startsWith("<");

	if (tilde || caret) {
		const lo = parseVersion(cmp.slice(1));
		if (tilde) {
			// ~1.2.3  => >=1.2.3 <1.3.0
			const hi: SemVer = {
				major: lo.major,
				minor: lo.minor + 1,
				patch: 0,
				prerelease: [],
			};
			return compare(v, lo) >= 0 && compare(v, hi) < 0;
		}
		// ^1.2.3  => >=1.2.3 <2.0.0 ; ^0.2.3 => >=0.2.3 <0.3.0 ; ^0.0.3 => >=0.0.3 <0.0.4
		if (lo.major > 0) {
			const hi: SemVer = {
				major: lo.major + 1,
				minor: 0,
				patch: 0,
				prerelease: [],
			};
			return compare(v, lo) >= 0 && compare(v, hi) < 0;
		}
		if (lo.minor > 0) {
			const hi: SemVer = {
				major: 0,
				minor: lo.minor + 1,
				patch: 0,
				prerelease: [],
			};
			return compare(v, lo) >= 0 && compare(v, hi) < 0;
		}
		const hi: SemVer = {
			major: 0,
			minor: 0,
			patch: lo.patch + 1,
			prerelease: [],
		};
		return compare(v, lo) >= 0 && compare(v, hi) < 0;
	}

	if (ge) return compare(v, parseVersion(cmp.slice(2))) >= 0;
	if (gt) return compare(v, parseVersion(cmp.slice(1))) > 0;
	if (le) return compare(v, parseVersion(cmp.slice(2))) <= 0;
	if (lt) return compare(v, parseVersion(cmp.slice(1))) < 0;

	// Exact / whitespace-tolerated comparison.
	return compare(v, parseVersion(cmp)) === 0;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const pluginPkg = readJson("node_modules/@opencode/plugin/package.json");
const myPkg = readJson("package.json");

const pluginVersion = String(pluginPkg["version"] ?? "unknown");
const pluginEffect = String(
	(pluginPkg["dependencies"] as Record<string, unknown> | undefined)?.[
		"effect"
	] ?? "",
);
const myPeer = String(
	(myPkg["peerDependencies"] as Record<string, unknown> | undefined)?.[
		"effect"
	] ?? "",
);

const missing: string[] = [];
if (!pluginEffect)
	missing.push("`@opencode/plugin` does not declare an `effect` dependency");
if (!myPeer) missing.push("this package has no `effect` peerDependency");
if (missing.length) fail(`${missing.join("; ")}.`);

if (!pluginPkg["version"]) fail("`@opencode/plugin` has no `version`.");

console.log(
	`check-effect:\n   @opencode/plugin@${pluginVersion}  ->  effect ${pluginEffect}\n   our peerDependency          ->  effect ${myPeer}\n`,
);

// 1) Does the plugin's effect version satisfy our peer range at all?
if (!satisfies(pluginEffect, myPeer)) {
	fail(
		`@opencode/plugin@${pluginVersion} depends on effect ${pluginEffect}, which does NOT satisfy our peerDependency range "${myPeer}". This means the plugin and our plugin could end up on different effect instances (broken fibers/schemas at runtime). Update our peerDependencies to a range that includes effect ${pluginEffect}.`,
	);
}

// 2) Even when it satisfies the range, flag meaningful drift (major / minor / patch).
//    Compute the floor of our peer range for drift comparison.
const floorMatch = myPeer.match(/(\d+)\.(\d+)\.(\d+)/);
if (!floorMatch) {
	// Range with no concrete floor (e.g. "*") — we can't reason about drift; already satisfied above.
	console.log("ok: effect range satisfied (no pin to reason about drift).");
	process.exit(0);
}

const floor: SemVer = {
	major: Number(floorMatch[1]),
	minor: Number(floorMatch[2]),
	patch: Number(floorMatch[3]),
	prerelease: [],
};
const pluginV = parseVersion(pluginEffect);

if (pluginV.major !== floor.major || pluginV.minor !== floor.minor) {
	fail(
		`MAJOR/MINOR DRIFT: @opencode/plugin uses effect ${pluginEffect}, but our peer range "${myPeer}" is floored at ${floor.major}.${floor.minor}.${floor.patch}. Since effect minor releases can contain breaking changes and OpenCode requires a matching major line, confirm this bump is intentional. Prefer aligning our peer range floor to ${pluginV.major}.${pluginV.minor}.0 (or the newest compatible line).`,
	);
}

if (pluginV.patch !== floor.patch) {
	warn(
		`patch-level drift: @opencode/plugin uses effect ${pluginEffect}, peer floor is ${floor.major}.${floor.minor}.${floor.patch}. Almost always safe, but verify the range allows this exact version.`,
	);
}

console.log("ok: effect version matches the declared peer range.");
process.exit(hadWarning ? 2 : 0);
