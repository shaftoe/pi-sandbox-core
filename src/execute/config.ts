import { buildSystemPrompt } from "../prompt";
import type { ExecuteContext, ExecuteParams, RunConfig } from "./types";

export function resolveModel(
	params: ExecuteParams,
	ctx: ExecuteContext,
): RunConfig {
	const currentModel = ctx.model;
	const resolvedModel =
		params.model ??
		(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined);
	return {
		task: params.task,
		model: resolvedModel,
		systemPrompt: buildSystemPrompt(ctx.cwd, params.systemPrompt),
		tools: params.tools?.split(","),
		timeoutMs: params.timeout ? params.timeout * 1000 : undefined,
	};
}
