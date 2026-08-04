/**
 * Archive the failures a red gate parsed, so B6 and B7 can one day be measured
 * on real ones.
 *
 * Both premises ask for "20 real mechanical failures". Every run so far has
 * produced about one, synthetic, and the reason is an instrument gap rather than
 * a shortage of failures: `gate` parses a typed `Failure[]` on every red run and
 * hands it to the CALLER, while its telemetry row keeps only
 * `{ checks: [names], passed }`. The failures are computed and then dropped.
 * This is the third time on this branch that a field the caller sees never
 * reached the log — after `rounds[]` and `model` — which is why the pattern is
 * named here and not just fixed again.
 *
 * What this is NOT: a judgement about whether a captured failure is *mechanical*
 * in B6's sense. That labelling is human, happens when a corpus is assembled,
 * and has to be recorded with whoever did it.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Failure } from "./checks/parsers.js";
import { defaultProcessRunner, type ProcessRunner } from "./exec.js";
import { log } from "./logger.js";

export const CORPUS_DIR = path.join(".local-coder", "corpus");

/** Git calls here are read-only bookkeeping, not the work; keep them short. */
const GIT_TIMEOUT_MS = 15_000;

/**
 * Above this the patch is DROPPED, not cut.
 *
 * A truncated patch is worse than no patch: it still applies cleanly for a
 * while and then stops mid-hunk, so it reads as a reproducible capture right up
 * until someone depends on it. Same principle as `enforceContextCaps` refusing
 * rather than truncating, and as the analyzer sentinel in the verification
 * script — a partial artefact must not be able to pass as a whole one.
 */
const MAX_PATCH_BYTES = 256 * 1024;

export interface CapturedCheck {
  name: string;
  category: string;
  failure_count: number;
  failures: Failure[];
}

export interface CaptureInput {
  /** Joins this file to the `gate` row in `telemetry.jsonl`. */
  invocationId: string;
  checks: CapturedCheck[];
}

export interface CorpusWriter {
  /** Returns the repo-relative path written, or null when nothing was written. */
  capture(input: CaptureInput): Promise<string | null>;
}

export interface CorpusDeps {
  runner?: ProcessRunner;
  now?: () => Date;
}

async function git(
  runner: ProcessRunner,
  root: string,
  args: string[]
): Promise<string | null> {
  try {
    const result = await runner("git", args, { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0 || result.timedOut) return null;
    return result.stdout;
  } catch {
    // No git, no repository, git too old — all the same answer here: the tree
    // state could not be recorded. The failures still can be, and are.
    return null;
  }
}

/**
 * The working tree, as far as it can be recorded without touching anything.
 *
 * `git diff HEAD` covers tracked changes, staged and not. It does NOT cover
 * untracked files, and the usual trick for that — `git add -N` — writes to the
 * index. A capture hook that mutates the repository it is observing is not a
 * capture hook, so untracked paths are LISTED instead: the reader learns that
 * they existed and are missing from the patch, which is the honest version of
 * not having them.
 */
async function treeState(
  runner: ProcessRunner,
  root: string
): Promise<{
  head: string | null;
  patch: string | null;
  patch_bytes: number;
  patch_omitted: boolean;
  untracked: string[];
}> {
  const head = (await git(runner, root, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const rawPatch = await git(runner, root, ["diff", "HEAD"]);
  const untrackedOut = await git(runner, root, ["ls-files", "--others", "--exclude-standard"]);
  const untracked =
    untrackedOut === null
      ? []
      : untrackedOut
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "");

  if (rawPatch === null) {
    return { head, patch: null, patch_bytes: 0, patch_omitted: false, untracked };
  }
  const bytes = Buffer.byteLength(rawPatch, "utf8");
  if (bytes > MAX_PATCH_BYTES) {
    log.warn(`corpus: patch is ${bytes} bytes, over the ${MAX_PATCH_BYTES} cap; recording its size only`);
    return { head, patch: null, patch_bytes: bytes, patch_omitted: true, untracked };
  }
  return { head, patch: rawPatch, patch_bytes: bytes, patch_omitted: false, untracked };
}

export function createCorpusWriter(root: string, deps: CorpusDeps = {}): CorpusWriter {
  const runner = deps.runner ?? defaultProcessRunner;
  const now = deps.now ?? ((): Date => new Date());

  return {
    async capture(input: CaptureInput): Promise<string | null> {
      // A capture that throws would turn a gate run that WORKED into a failed
      // tool call. Nothing here is worth that, so every path below is inside
      // this boundary and the worst outcome is a warning and no file.
      try {
        const withFailures = input.checks.filter((c) => c.failure_count > 0);
        if (withFailures.length === 0) return null;

        const state = await treeState(runner, root);
        const ts = now().toISOString();
        const entry = {
          ts,
          invocation_id: input.invocationId,
          checks: withFailures,
          tree: state,
          /**
           * Deliberately absent: whether this is a MECHANICAL failure in B6's
           * sense. A capture step that guessed would be writing a label nobody
           * verified into the corpus the labels are supposed to describe.
           */
        };

        const dir = path.join(root, CORPUS_DIR);
        await fs.mkdir(dir, { recursive: true });
        // Named by time and invocation: sorts chronologically, and the id makes
        // it joinable to the telemetry row without opening the file.
        const stamp = ts.replace(/[:.]/g, "-");
        const short = createHash("sha256").update(input.invocationId).digest("hex").slice(0, 8);
        const rel = path.join(CORPUS_DIR, `${stamp}-${short}.json`);
        await fs.writeFile(path.join(root, rel), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
        log.info(
          `corpus: captured ${withFailures.reduce((n, c) => n + c.failure_count, 0)} failure(s) to ${rel}`
        );
        return rel.split(path.sep).join("/");
      } catch (error) {
        log.warn(`corpus: could not capture this run (${error instanceof Error ? error.message : String(error)})`);
        return null;
      }
    },
  };
}
