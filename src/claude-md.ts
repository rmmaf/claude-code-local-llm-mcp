import { promises as fs } from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { log } from "./logger.js";

/**
 * Install the delegation policy into the project's CLAUDE.md.
 *
 * Why this is code and not a line in the README: it WAS a line in the README.
 * `README.md` has said "add this to your project's CLAUDE.md so Claude routes
 * work to the local model on its own" since the first release, and
 * `run 2026-08-04-mac-10` measured what that is worth — 36 Bash verifications,
 * 0 `gate` calls, in a repository whose own author had never installed the
 * block. An instruction that even its writer does not follow is not a default;
 * it is a wish. The server ships the default instead.
 *
 * Everything here is deliberately timid. It writes into someone else's project,
 * so it refuses more often than it acts: it never overwrites, never rewrites a
 * block a user has edited, never touches a directory that does not look like a
 * project, and never turns a failure of its own into a failure of the server.
 */

/** Version the marker, not just the text: a later block must be able to recognise an earlier one. */
const MARKER_VERSION = "v1";
const MARKER_BEGIN_PREFIX = "<!-- local-coder:policy:begin";
const MARKER_BEGIN = `${MARKER_BEGIN_PREFIX} ${MARKER_VERSION} -->`;
const MARKER_END = "<!-- local-coder:policy:end -->";

/**
 * Kept byte-for-byte in sync with the fenced block in `README.md` by
 * `tests/claude-md.test.ts`. The drift this guards against is the exact failure
 * that produced this module: documentation and behaviour disagreeing, with only
 * the documentation being read.
 */
const RAW_POLICY_BODY = `## Local delegation policy
- Verify with mcp__local-coder__gate, never by running lint/tsc/tests through
  Bash. One call runs them all and returns only structured failures.
- When the gate is red and the fix is mechanical (type errors, failing
  assertions, lint, missing imports), call mcp__local-coder__repair instead of
  fixing and re-testing yourself. It loops locally and returns one diff.
- Delegate new-file creation from a spec to mcp__local-coder__scaffold.
- Use mcp__local-coder__implement only for bulk mechanical authoring — it saves
  the smallest part of the bill.
- Keep in Claude: architecture decisions, API design, subtle debugging,
  security-sensitive code, and final review of every diff before apply.
- Never paste file contents into tool arguments — pass relative paths.
- Escalate to yourself after 2 failed local attempts on the same unit.`;

/**
 * Normalised because the literal above is NOT platform-independent: with git's
 * `autocrlf` on, a Windows checkout puts CRLF inside the template literal
 * itself, so the same source would write a different file on each machine. The
 * bytes this server puts in someone's project should not depend on how the
 * developer cloned it.
 */
export const POLICY_BODY = RAW_POLICY_BODY.replace(/\r\n/g, "\n");

export const POLICY_BLOCK = `${MARKER_BEGIN}\n${POLICY_BODY}\n${MARKER_END}\n`;

export const CLAUDE_MD_REL_PATH = "CLAUDE.md";

export type ClaudeMdState =
  /** No CLAUDE.md existed; one was written. */
  | "created"
  /** A CLAUDE.md existed without our block; the block was appended. */
  | "appended"
  /** Our block was already there. Nothing was written, whatever the body now says. */
  | "present"
  /** The root has neither `.git` nor `package.json`, so it is probably not a project. */
  | "skipped_not_a_project"
  /** LOCAL_CODER_AUTO_CLAUDE_MD is off. */
  | "disabled"
  /** Something went wrong. The server carried on; this says so out loud. */
  | "failed";

export interface ClaudeMdResult {
  state: ClaudeMdState;
  /** Absolute path of the file, or null when nothing was looked at. */
  path: string | null;
  /** Present only on `failed`, and only to make the log line readable. */
  detail?: string;
}

let lastResult: ClaudeMdResult | null = null;

/**
 * What `ensureClaudeMd` did at startup, for `status` to report. Null when it has
 * not run in this process — which is the honest answer in a unit test, and a
 * real signal in a server that somehow reached a tool call without starting up.
 */
export function getClaudeMdState(): ClaudeMdResult | null {
  return lastResult;
}

/** Test-only: forget the recorded startup outcome. */
export function resetClaudeMdState(): void {
  lastResult = null;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A project is somewhere with a `.git` or a `package.json`. The guard is not
 * about correctness — appending to a stray CLAUDE.md would be harmless — but
 * about blast radius: a server launched from `~` or `/` should not leave a file
 * there, and a user who finds one has no way to know what wrote it.
 *
 * `.git` is checked with `access`, not `stat().isDirectory()`: in a worktree it
 * is a FILE, and this repository does its work in worktrees.
 */
async function looksLikeProject(root: string): Promise<boolean> {
  return (await exists(path.join(root, ".git"))) || (await exists(path.join(root, "package.json")));
}

/**
 * Write the policy into `<root>/CLAUDE.md` if it is not already there.
 *
 * Never throws. Records its outcome for `status` and returns it.
 */
export async function ensureClaudeMd(config: Config): Promise<ClaudeMdResult> {
  const record = (result: ClaudeMdResult): ClaudeMdResult => {
    lastResult = result;
    return result;
  };

  if (!config.autoClaudeMd) {
    return record({ state: "disabled", path: null });
  }

  const target = path.join(config.root, CLAUDE_MD_REL_PATH);

  try {
    if (!(await looksLikeProject(config.root))) {
      log.warn(
        `claude-md: ${config.root} has no .git or package.json; not writing CLAUDE.md there`
      );
      return record({ state: "skipped_not_a_project", path: target });
    }

    let existing: string;
    try {
      existing = await fs.readFile(target, "utf8");
    } catch {
      existing = null;
    }

    if (existing === null) {
      await fs.writeFile(target, POLICY_BLOCK, "utf8");
      log.info(`claude-md: created ${target} with the local-coder delegation policy`);
      return record({ state: "created", path: target });
    }

    // Version-agnostic on purpose: a v2 block must recognise a v1 one and leave
    // it alone rather than appending a second copy. Upgrading someone's edited
    // policy is a decision for a human, not a side effect of a server start.
    if (existing.includes(MARKER_BEGIN_PREFIX)) {
      return record({ state: "present", path: target });
    }

    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    await fs.writeFile(target, `${existing}${separator}${POLICY_BLOCK}`, "utf8");
    log.info(`claude-md: appended the local-coder delegation policy to ${target}`);
    return record({ state: "appended", path: target });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`claude-md: could not install the delegation policy: ${detail}`);
    return record({ state: "failed", path: target, detail });
  }
}
