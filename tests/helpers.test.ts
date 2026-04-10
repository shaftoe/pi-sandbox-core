import { describe, expect, it } from "bun:test";
import {
	parseJsonlOutput,
	escapeShellArg,
	buildPiArgs,
	parseGitStatus,
	raceWithAbort,
} from "../src/helpers";
import type { PiRunResult } from "../src/types";

// ── parseJsonlOutput ───────────────────────────────────────────────────

describe("parseJsonlOutput", () => {
	it("returns empty result for empty stdout", () => {
		const result = parseJsonlOutput("", "", null);
		expect(result.messages).toEqual([]);
		expect(result.usage.turns).toBe(0);
		expect(result.exitCode).toBeNull();
	});

	it("parses message_end events", () => {
		const stdout = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 } },
			},
		});

		const result = parseJsonlOutput(stdout, "", 0);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("assistant");
		expect(result.usage.input).toBe(100);
		expect(result.usage.output).toBe(50);
		expect(result.usage.turns).toBe(1);
		expect(result.usage.cost).toBe(0.01);
	});

	it("parses tool_result_end events", () => {
		const stdout = JSON.stringify({
			type: "tool_result_end",
			message: { role: "tool", content: [{ type: "text", text: "result" }] },
		});

		const result = parseJsonlOutput(stdout, "", 0);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("tool");
	});

	it("skips non-JSON lines", () => {
		const stdout = "not json\n{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\"}}\nalso not json";
		const result = parseJsonlOutput(stdout, "err", 1);
		expect(result.messages).toHaveLength(1);
		expect(result.stderr).toBe("err");
		expect(result.exitCode).toBe(1);
	});

	it("accumulates usage across multiple turns", () => {
		const msg = (input: number, output: number) =>
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			});

		const result = parseJsonlOutput(`${msg(100, 50)}\n${msg(200, 75)}`, "", 0);
		expect(result.usage.input).toBe(300);
		expect(result.usage.output).toBe(125);
		expect(result.usage.turns).toBe(2);
		expect(result.usage.cost).toBeCloseTo(0.002);
	});
});

// ── escapeShellArg ─────────────────────────────────────────────────────

describe("escapeShellArg", () => {
	it("wraps in single quotes", () => {
		expect(escapeShellArg("hello")).toBe("'hello'");
	});

	it("escapes embedded single quotes", () => {
		expect(escapeShellArg("it's")).toBe("'it'\\''s'");
	});

	it("handles empty string", () => {
		expect(escapeShellArg("")).toBe("''");
	});
});

// ── buildPiArgs ────────────────────────────────────────────────────────

describe("buildPiArgs", () => {
	it("builds minimal args", () => {
		const args = buildPiArgs({ task: "do stuff" });
		expect(args).toContain("pi");
		expect(args).toContain("--mode");
		expect(args).toContain("json");
		expect(args).toContain("@/tmp/pi-task.md");
	});

	it("includes model when set", () => {
		const args = buildPiArgs({ task: "do stuff", model: "google/gemini-2.5-pro" });
		expect(args).toContain("--model");
		const modelIdx = args.indexOf("--model");
		expect(args[modelIdx + 1]).toBe("'google/gemini-2.5-pro'");
	});

	it("includes tools when set", () => {
		const args = buildPiArgs({ task: "do stuff", tools: ["read", "write"] });
		expect(args).toContain("--tools");
		expect(args).toContain("read,write");
	});

	it("includes system prompt when set", () => {
		const args = buildPiArgs({ task: "do stuff", systemPrompt: "be helpful" });
		expect(args).toContain("--append-system-prompt");
		expect(args).toContain("/tmp/pi-system.md");
	});
});

// ── parseGitStatus ─────────────────────────────────────────────────────

describe("parseGitStatus", () => {
	it("parses porcelain output", () => {
		const output = "M  src/index.ts\n?? new-file.ts\nA  added.ts";
		const files = parseGitStatus(output);
		expect(files).toEqual(["src/index.ts", "new-file.ts", "added.ts"]);
	});

	it("returns empty array for empty input", () => {
		expect(parseGitStatus("")).toEqual([]);
	});
});

// ── raceWithAbort ──────────────────────────────────────────────────────

describe("raceWithAbort", () => {
	it("resolves normally when not aborted", async () => {
		const result = await raceWithAbort(Promise.resolve(42), new AbortController().signal);
		expect(result).toBe(42);
	});

	it("rejects immediately if signal already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(raceWithAbort(Promise.resolve(42), controller.signal)).rejects.toThrow();
	});

	it("rejects when signal aborts during execution", async () => {
		const controller = new AbortController();
		const promise = new Promise((resolve) => setTimeout(() => resolve(42), 5000));
		setTimeout(() => controller.abort(), 10);
		await expect(raceWithAbort(promise, controller.signal)).rejects.toThrow();
	});

	it("propagates non-abort rejection and removes listener", async () => {
		const controller = new AbortController();
		const signal = controller.signal;
		const promise = Promise.reject(new Error("boom"));
		await expect(raceWithAbort(promise, signal)).rejects.toThrow("boom");
	});
});
