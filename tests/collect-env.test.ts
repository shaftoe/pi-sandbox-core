import { describe, expect, it } from "bun:test";
import { collectForwardedEnv, getFinalOutput, withTimeout } from "../src/utils";
import type { PiMessage } from "../src/types";

describe("collectForwardedEnv", () => {
	it("collects vars with matching prefix", () => {
		process.env.TEST_PREFIX_MY_VAR = "hello";
		process.env.TEST_PREFIX_OTHER = "world";
		process.env.NO_MATCH = "ignored";

		const env = collectForwardedEnv("TEST_PREFIX_", new Set());
		expect(env.MY_VAR).toBe("hello");
		expect(env.OTHER).toBe("world");
		expect(env.NO_MATCH).toBeUndefined();

		delete process.env.TEST_PREFIX_MY_VAR;
		delete process.env.TEST_PREFIX_OTHER;
		delete process.env.NO_MATCH;
	});

	it("excludes vars in exclude set", () => {
		process.env.TEST_PREFIX_SECRET = "sensitive";

		const env = collectForwardedEnv("TEST_PREFIX_", new Set(["SECRET"]));
		expect(env.SECRET).toBeUndefined();

		delete process.env.TEST_PREFIX_SECRET;
	});

	it("includes GITHUB_TOKEN from host if not already set", () => {
		const original = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = "ghp_test123";

		const env = collectForwardedEnv("TEST_PREFIX_", new Set());
		expect(env.GITHUB_TOKEN).toBe("ghp_test123");

		if (original) {
			process.env.GITHUB_TOKEN = original;
		} else {
			delete process.env.GITHUB_TOKEN;
		}
	});

	it("prefix var takes precedence over GITHUB_TOKEN", () => {
		process.env.TEST_PREFIX_GITHUB_TOKEN = "prefix-token";
		process.env.GITHUB_TOKEN = "host-token";

		const env = collectForwardedEnv("TEST_PREFIX_", new Set());
		expect(env.GITHUB_TOKEN).toBe("prefix-token");

		delete process.env.TEST_PREFIX_GITHUB_TOKEN;
		delete process.env.GITHUB_TOKEN;
	});
});

describe("getFinalOutput", () => {
	it("extracts last assistant message text", () => {
		const messages: PiMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "last" }] },
		];
		expect(getFinalOutput(messages)).toBe("last");
	});

	it("returns empty string when no assistant message", () => {
		expect(getFinalOutput([{ role: "user", content: [] }])).toBe("");
	});

	it("joins multiple text blocks", () => {
		const messages: PiMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "part1" },
					{ type: "image", url: "ignored" },
					{ type: "text", text: "part2" },
				],
			},
		];
		expect(getFinalOutput(messages)).toBe("part1\npart2");
	});
});

describe("withTimeout", () => {
	it("resolves when promise completes in time", async () => {
		await withTimeout(Promise.resolve(undefined), 1000, "test");
		// no throw = success
	});

	it("does not reject when promise takes too long", async () => {
		const slow = new Promise((resolve) => setTimeout(resolve, 5000));
		await withTimeout(slow, 10, "test");
		// should resolve (with "timeout") without throwing
	});
});
