import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build the subagent's system prompt by injecting project-level context
 * (AGENTS.md, .pi/instructions.md) alongside the user-provided system prompt.
 */
export function buildSystemPrompt(
	cwd: string,
	userPrompt?: string,
): string | undefined {
	const sections: string[] = [];

	// Inject project-level convention files
	const projectFiles = ["AGENTS.md", join(".pi", "instructions.md")];
	for (const file of projectFiles) {
		const filePath = join(cwd, file);
		if (existsSync(filePath)) {
			const content = readFileSync(filePath, "utf-8").trim();
			if (content) {
				sections.push(`## ${file}\n\n${content}`);
			}
		}
	}

	// Append user-provided system prompt
	if (userPrompt?.trim()) {
		sections.push(userPrompt.trim());
	}

	return sections.length > 0 ? sections.join("\n\n") : undefined;
}
