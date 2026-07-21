import { z } from "zod";

import type { Config } from "../config.js";
import { implementInputSchema } from "./implement.js";
import { runGeneration, type GenerationResult, type ToolDeps } from "./shared.js";

export const fixToolName = "fix";

export const fixToolDescription = `The local repair loop: hand a concrete failure (test, compiler, or linter output) back to the local LLM for a MINIMAL targeted fix, returned as a reviewable unified diff. Same contract as implement — you send a spec, relative file paths, and the verbatim error output; the server reads files from disk and returns only a diff plus summary. File contents never enter your context.

Use it when: tests, type-checking, or lint fail on code the local model produced (or on similarly mechanical breakage) and the error output points clearly at the problem.

Do NOT use it for: subtle logic bugs, race conditions, or anything needing real debugging — and after 2 failed local attempts on the same unit, stop delegating and fix it yourself. Not for new features (use implement) or new files (use scaffold).

Never paste file contents into any argument — only relative paths (which must exist) and the error output text. Start with mode "diff" (default), review, then "apply".`;

export const fixInputSchema = {
  ...implementInputSchema,
  error_output: z
    .string()
    .min(1)
    .describe(
      "The failing test/compiler/linter output, verbatim. The model is instructed to make the minimal change that resolves exactly this."
    ),
};

const argsSchema = z.object(fixInputSchema);

export type FixArgs = z.infer<typeof argsSchema>;

export async function runFix(
  args: FixArgs,
  config: Config,
  deps: ToolDeps = {}
): Promise<GenerationResult> {
  return runGeneration("fix", args, config, deps);
}
