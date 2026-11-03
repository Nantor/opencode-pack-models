import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Host } from "@opencode/plugin/host";
import { buildSingleFile } from "../scripts/build.ts";

test("built directory resolves its server inside dist without a custom TUI across rebuilds", () => {
	const directory = resolve(import.meta.dir, "../dist");
	for (let i = 0; i < 2; i++) {
		buildSingleFile(resolve(directory, "opencode-pack-models.ts"));
		expect(existsSync(resolve(directory, "package.json"))).toBe(false);
		const parts = Host.resolve({ directory });
		expect(parts.server).toBe(new URL(`file://${directory}/server.ts`).href);
		expect(parts.tui).toBeUndefined();
	}
});
