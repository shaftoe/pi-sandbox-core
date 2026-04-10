import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt } from "../src/prompt";

describe("buildSystemPrompt", () => {
	const testDir = join(tmpdir(), `pi-sandbox-core-test-prompt`);

	it("returns undefined when no files and no user prompt", () => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
		expect(buildSystemPrompt(testDir)).toBeUndefined();
	});

	it("injects AGENTS.md content", () => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
		writeFileSync(join(testDir, "AGENTS.md"), "Always use TypeScript.\n");

		const result = buildSystemPrompt(testDir);
		expect(result).toContain("## AGENTS.md");
		expect(result).toContain("Always use TypeScript.");
	});

	it("injects .pi/instructions.md content", () => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
		mkdirSync(join(testDir, ".pi"), { recursive: true });
		writeFileSync(join(testDir, ".pi", "instructions.md"), "Prefer bun over npm.\n");

		const result = buildSystemPrompt(testDir);
		expect(result).toContain("## .pi/instructions.md");
		expect(result).toContain("Prefer bun over npm.");
	});

	it("skips files that exist but are empty/whitespace", () => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
		writeFileSync(join(testDir, "AGENTS.md"), "   \n  \n");

		expect(buildSystemPrompt(testDir)).toBeUndefined();
	});

	it("appends user-provided system prompt", () => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });

		const result = buildSystemPrompt(testDir, "Be concise.");
		expect(result).toBe("Be concise.");
	});

	it("combines project files and user prompt", () => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
		writeFileSync(join(testDir, "AGENTS.md"), "Use tabs.\n");

		const result = buildSystemPrompt(testDir, "Be helpful.");
		expect(result).toContain("## AGENTS.md");
		expect(result).toContain("Use tabs.");
		expect(result).toContain("Be helpful.");
	});

	// Cleanup
	it("cleans up", () => {
		rmSync(testDir, { recursive: true, force: true });
	});
});
