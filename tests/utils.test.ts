import { describe, expect, it } from "bun:test";
import { textContent, isAbortError } from "../src/execute/utils";

describe("textContent", () => {
	it("creates a text content object", () => {
		const result = textContent("hello");
		expect(result).toEqual({ type: "text", text: "hello" });
	});
});

describe("isAbortError", () => {
	it("returns true when signal is aborted", () => {
		const controller = new AbortController();
		controller.abort();
		expect(isAbortError(new Error("oops"), controller.signal)).toBe(true);
	});

	it("returns true for DOMException AbortError", () => {
		const error = new DOMException("Aborted", "AbortError");
		expect(isAbortError(error, undefined)).toBe(true);
	});

	it("returns false for normal error and no signal", () => {
		expect(isAbortError(new Error("oops"), undefined)).toBe(false);
	});

	it("returns false for non-aborted signal and non-abort error", () => {
		expect(isAbortError(new Error("oops"), new AbortController().signal)).toBe(false);
	});
});
