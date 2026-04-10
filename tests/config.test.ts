import { describe, expect, it } from "bun:test";
import { resolveModel } from "../src/execute/config";
import type { ExecuteContext, ExecuteParams } from "../src/execute/types";

describe("resolveModel", () => {
	const baseCtx: ExecuteContext = {
		cwd: "/tmp/test",
		workspacePath: "/workspace",
		envPrefix: "TEST_ENV_",
		envExclude: new Set(),
		ui: { notify: () => {} },
	};

	it("uses params.model when set", () => {
		const config = resolveModel(
			{ task: "do it", model: "google/gemini-2.5-pro" },
			baseCtx,
		);
		expect(config.model).toBe("google/gemini-2.5-pro");
	});

	it("derives model from ctx.model", () => {
		const config = resolveModel(
			{ task: "do it" },
			{ ...baseCtx, model: { provider: "anthropic", id: "claude-4" } },
		);
		expect(config.model).toBe("anthropic/claude-4");
	});

	it("returns undefined model when neither set", () => {
		const config = resolveModel({ task: "do it" }, baseCtx);
		expect(config.model).toBeUndefined();
	});

	it("converts timeout from seconds to ms", () => {
		const config = resolveModel({ task: "do it", timeout: 30 }, baseCtx);
		expect(config.timeoutMs).toBe(30_000);
	});

	it("parses tools string to array", () => {
		const config = resolveModel({ task: "do it", tools: "read,write,bash" }, baseCtx);
		expect(config.tools).toEqual(["read", "write", "bash"]);
	});
});
