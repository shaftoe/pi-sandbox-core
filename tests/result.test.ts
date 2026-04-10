import { describe, expect, it } from "bun:test";
import {
	formatSuccessResult,
	formatCancelledResult,
	formatFailureResult,
} from "../src/execute/result";
import type { PiRunResult } from "../src/types";

describe("formatSuccessResult", () => {
	it("formats success with diff", () => {
		const result: PiRunResult = {
			exitCode: 0,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Done!" }],
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			],
			stderr: "",
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
		};

		const out = formatSuccessResult("vm-123", result, {
			changedFiles: ["src/foo.ts"],
			diff: "+added line",
		});

		expect(out.content[0].type).toBe("text");
		expect(out.content[0].text).toBe("Done!");
		expect(out.details.sandboxId).toBe("vm-123");
		expect(out.details.diff).toBe("+added line");
		expect(out.details.changedFiles).toEqual(["src/foo.ts"]);
	});

	it("formats success with no diff", () => {
		const result: PiRunResult = {
			exitCode: 0,
			messages: [],
			stderr: "some warning",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		};

		const out = formatSuccessResult("sb-456", result, null);
		expect(out.details.diff).toBe("");
		expect(out.content[0].text).toContain("stderr");
	});
});

describe("formatCancelledResult", () => {
	it("returns cancelled details", () => {
		const out = formatCancelledResult("vm-789");
		expect(out.content[0].text).toContain("cancelled");
		expect(out.details.cancelled).toBe(true);
		expect(out.details.sandboxId).toBe("vm-789");
		expect(out.details.usage.cost).toBe(0);
	});
});

describe("formatFailureResult", () => {
	it("returns failure details", () => {
		const out = formatFailureResult("vm-fail", {
			content: "clone failed",
			exitCode: 128,
		});
		expect(out.content[0].text).toBe("clone failed");
		expect(out.details.exitCode).toBe(128);
		expect(out.details.sandboxId).toBe("vm-fail");
	});
});
