import { z } from "zod";

import type { Config } from "../config.js";
import { runGeneration, type GenerationResult, type ToolDeps } from "./shared.js";

export const implementToolName = "implement";

export const implementToolDescription = `Delegate a well-specified coding task to the local LLM (LM Studio) and get back a reviewable unified diff. You send a tight spec plus RELATIVE FILE PATHS; this server reads the files from disk itself, prompts the local model, and returns only a git-apply-compatible diff and a short summary — file contents never enter your context, which is the whole point.

Use it for: multi-file implementations from a clear spec, boilerplate, test generation, mechanical refactors, docstrings — token-heavy work a strong local model handles well when the spec is precise.

Do NOT use it for: architecture decisions, API design, subtle debugging, or security-sensitive code — do those yourself. Do not use it to create brand-new files (use scaffold) or to fix a failing test/build on delegated code (use fix).

Never paste file contents into any argument — pass paths relative to the project root; every path in "files" must already exist on disk. Start with mode "diff" (the default) and review the returned diff. To land it, either apply the reviewed patch yourself (byte-exact), or re-run with mode "apply" — the server is stateless, so "apply" re-generates before writing; its returned diff is what was actually written, so check it still matches what you approved.`;

export const implementInputSchema = {
  spec: z
    .string()
    .min(1)
    .describe(
      "Detailed task specification: what to build, interfaces, constraints, acceptance criteria. The local model sees only this and the files — write it self-contained."
    ),
  files: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Editable target files as paths relative to the project root. Must exist. Paths only — never file contents."
    ),
  context_files: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Read-only reference files (types, interfaces, examples) included in the model prompt but never modified. Relative paths only."
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact model name to run, as it appears in LM Studio / the models CSV (sent verbatim as the chat model). Omit to auto-pick the largest configured model that fits free RAM. Call the `models` tool first to choose by objective + memory."
    ),
  mode: z
    .enum(["diff", "apply"])
    .optional()
    .describe(
      '"diff" (default) returns the patch without touching disk — the review gate. "apply" re-runs generation and writes the result atomically; its returned diff is what was actually written, so verify it matches the diff you reviewed (or apply that patch yourself for byte-exact results).'
    ),
};

const argsSchema = z.object(implementInputSchema);

export type ImplementArgs = z.infer<typeof argsSchema>;

export async function runImplement(
  args: ImplementArgs,
  config: Config,
  deps: ToolDeps = {}
): Promise<GenerationResult> {
  return runGeneration("implement", args, config, deps);
}
