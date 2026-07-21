import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { Config } from "../config.js";
import { atomicWriteFile, resolveSafePath, ToolError } from "../fs-safety.js";
import { chatCompletion, type ChatMessage, type Usage } from "../llm-client.js";
import { log } from "../logger.js";
import { FILE_BLOCK_FORMAT, parseFileBlocks } from "../parse.js";
import { autoSelectProfile, type Profile } from "../profile.js";
import { normalizeRel, type ToolDeps } from "./shared.js";

export const scaffoldToolName = "scaffold";

export const scaffoldToolDescription = `Generate brand-NEW files from a spec using the local LLM (LM Studio). Give it a spec and a target path — a single file, or a directory for multi-file output. New files are low-risk, so they are written to disk directly (no diff review gate) and the tool returns the created paths plus a summary. It refuses, with a clear error, if the target already exists: this tool never overwrites anything.

Use it for: new modules, components, test files, or config scaffolding from a clear spec.

Do NOT use it to modify existing files (use implement — it has the diff review gate) or to fix failures (use fix).

Never paste file contents into any argument — the spec describes what to create; target_path is a path relative to the project root that must NOT exist yet.`;

export const scaffoldInputSchema = {
  spec: z
    .string()
    .min(1)
    .describe("What to create: purpose, interfaces, constraints, acceptance criteria. Self-contained — the local model sees only this."),
  target_path: z
    .string()
    .min(1)
    .describe(
      "Relative path for the new file, or a directory (trailing slash or no file extension) for multi-file generation. Must not exist yet."
    ),
  profile: z
    .enum(["solo", "ide"])
    .optional()
    .describe("Model profile. Omit for memory-based auto-selection (solo = 30B model, ide = 14B fallback)."),
};

const argsSchema = z.object(scaffoldInputSchema);

export type ScaffoldArgs = z.infer<typeof argsSchema>;

export interface ScaffoldResult {
  summary: string;
  created: string[];
  model: string;
  profile: Profile;
  latency_ms: number;
  usage: Usage;
}

const SCAFFOLD_SYSTEM_PROMPT = `You are a senior software engineer creating new files from a precise specification.
Rules:
- Follow the specification exactly. Create only the files it calls for.
- Write complete, production-quality file contents — no placeholders or TODOs unless the specification asks for them.
- Use exactly this output format, one block per new file:
${FILE_BLOCK_FORMAT}
- Output nothing but <file> blocks: no prose, no explanations, no markdown fences.`;

function wordCap(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter((w) => w !== "");
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")} …`;
}

export async function runScaffold(
  args: ScaffoldArgs,
  config: Config,
  deps: ToolDeps = {}
): Promise<ScaffoldResult> {
  const started = Date.now();
  const target = await resolveSafePath(config.root, args.target_path, { mustExist: false });

  try {
    await fs.access(target.abs);
    throw new ToolError(
      `Target already exists: ${target.rel}. scaffold creates new files only — ` +
        "use implement to modify existing files, or pick a different target path.",
      "target_exists",
      { path: target.rel }
    );
  } catch (error) {
    if (error instanceof ToolError) throw error;
    // ENOENT — the target is free, which is what we want.
  }

  const dirMode = args.target_path.endsWith("/") || path.posix.extname(normalizeRel(args.target_path)) === "";
  const targetRel = normalizeRel(target.rel);

  const profile =
    args.profile ?? (await autoSelectProfile(config, deps.runner, deps.platform)).profile;
  const model = profile === "solo" ? config.modelSolo : config.modelIde;

  const instruction = dirMode
    ? `Create one or more new files under the directory "${targetRel}/". Every <file> block's path must start with "${targetRel}/".`
    : `Create exactly one new file at the path "${targetRel}". Use exactly that path in the <file> block.`;

  const messages: ChatMessage[] = [
    { role: "system", content: SCAFFOLD_SYSTEM_PROMPT },
    { role: "user", content: `# Task specification\n\n${args.spec.trim()}\n\n# Target\n\n${instruction}` },
  ];

  const accept = (p: string): boolean => {
    const normalized = normalizeRel(p);
    return dirMode ? normalized.startsWith(`${targetRel}/`) : normalized === targetRel;
  };

  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  let files: Map<string, string> | null = null;
  let lastProblem = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await chatCompletion({
      baseUrl: config.baseUrl,
      model,
      messages,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    usage.prompt_tokens += result.usage.prompt_tokens;
    usage.completion_tokens += result.usage.completion_tokens;

    const parsed = parseFileBlocks(result.content, accept);
    if (result.finishReason === "length") {
      lastProblem = "the response was truncated (finish_reason=length)";
    } else if (parsed.files.size === 0) {
      lastProblem = dirMode
        ? `no valid <file> blocks with paths under "${targetRel}/" were found`
        : `no <file> block with the exact path "${targetRel}" was found`;
    } else {
      files = parsed.files;
      break;
    }

    log.warn(`scaffold attempt ${attempt} malformed (${lastProblem})`);
    if (attempt === 1) {
      messages.push({ role: "assistant", content: result.content });
      messages.push({
        role: "user",
        content:
          `Your previous response was not usable: ${lastProblem}. ${instruction} ` +
          `Respond again using exactly this format and nothing else:\n\n${FILE_BLOCK_FORMAT}`,
      });
    }
  }

  if (files === null) {
    throw new ToolError(
      `The local model failed to produce valid scaffold output after a corrective retry: ${lastProblem}.`,
      "model_output_malformed",
      { problem: lastProblem, model, profile }
    );
  }

  const created: string[] = [];
  for (const [rel, content] of files) {
    const resolved = await resolveSafePath(config.root, normalizeRel(rel), { mustExist: false });
    let exists = true;
    try {
      await fs.access(resolved.abs);
    } catch {
      exists = false;
    }
    if (exists) {
      throw new ToolError(
        `Refusing to overwrite existing file: ${resolved.rel}. scaffold creates new files only.`,
        "target_exists",
        { path: resolved.rel }
      );
    }
    await atomicWriteFile(resolved.abs, content);
    created.push(resolved.rel);
    log.info(`scaffold created ${resolved.rel} (${content.length} chars)`);
  }

  const specExcerpt = wordCap(args.spec.trim().split(/\r?\n/)[0] ?? "", 30);
  return {
    summary: wordCap(
      `Scaffolded ${created.length} new file(s) for: ${specExcerpt}. Created: ${created.join(", ")}.`,
      120
    ),
    created,
    model,
    profile,
    latency_ms: Date.now() - started,
    usage,
  };
}
