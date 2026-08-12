import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAUDE_MD_REL_PATH,
  POLICY_BODY,
  POLICY_BLOCK,
  ensureClaudeMd,
  getClaudeMdState,
  resetClaudeMdState,
} from "../src/claude-md.js";
import { loadConfig } from "../src/config.js";
import { makeTempRoot, removeTempRoot, testConfig } from "./helpers.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = makeTempRoot("claude-md-test-");
  roots.push(root);
  return root;
}

/** A directory the module will accept as a project. */
async function project(): Promise<string> {
  const root = tempRoot();
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  return root;
}

function config(root: string, autoClaudeMd = true): ReturnType<typeof testConfig> {
  return testConfig(root, { autoClaudeMd });
}

async function read(root: string): Promise<string> {
  return fs.readFile(path.join(root, CLAUDE_MD_REL_PATH), "utf8");
}

beforeEach(() => {
  resetClaudeMdState();
});

afterEach(async () => {
  resetClaudeMdState();
  while (roots.length > 0) {
    const root = roots.pop();
    await removeTempRoot(root);
  }
});

describe("policy text", () => {
  /**
   * The reason this module exists is that documentation and behaviour drifted:
   * `README.md` told every user to install a routing policy by hand, and
   * `run 2026-08-04-mac-10` measured a session where nobody had — including the
   * repository's own author. Shipping the block in code fixes that once; this
   * test is what stops the two copies from disagreeing afterwards.
   */
  it("matches the block README.md tells users to paste, line for line", async () => {
    const readmePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "README.md"
    );
    // Line endings normalised on both sides: with git's `autocrlf` the README
    // arrives CRLF on Windows and LF on the Mac, and a test that failed on one
    // machine and passed on the other would be worse than no test at all.
    const readme = (await fs.readFile(readmePath, "utf8")).replace(/\r\n/g, "\n");

    const fenced = readme.match(/```markdown\n(## Local delegation policy\n[\s\S]*?)```/);
    expect(fenced, "README.md no longer contains the fenced delegation policy block").not.toBeNull();

    expect(fenced?.[1]?.trimEnd()).toBe(POLICY_BODY);
  });

  it("wraps the body in markers that survive a version bump", () => {
    expect(POLICY_BLOCK).toContain("<!-- local-coder:policy:begin v1 -->");
    expect(POLICY_BLOCK).toContain("<!-- local-coder:policy:end -->");
    expect(POLICY_BLOCK.endsWith("\n")).toBe(true);
  });

  it("routes verification to gate, which is the whole point of installing it", () => {
    expect(POLICY_BODY).toContain("Verify with mcp__local-coder__gate");
  });
});

describe("ensureClaudeMd", () => {
  it("creates the file when the project has none", async () => {
    const root = await project();
    const result = await ensureClaudeMd(config(root));

    expect(result.state).toBe("created");
    expect(await read(root)).toBe(POLICY_BLOCK);
  });

  it("appends to an existing CLAUDE.md without disturbing what was there", async () => {
    const root = await project();
    const existing = "# House rules\n\n- Always use tabs.\n";
    await fs.writeFile(path.join(root, CLAUDE_MD_REL_PATH), existing, "utf8");

    const result = await ensureClaudeMd(config(root));

    expect(result.state).toBe("appended");
    const after = await read(root);
    expect(after.startsWith(existing)).toBe(true);
    expect(after).toContain(POLICY_BODY);
  });

  it("separates an appended block from a file that does not end in a newline", async () => {
    const root = await project();
    await fs.writeFile(path.join(root, CLAUDE_MD_REL_PATH), "- no trailing newline", "utf8");

    await ensureClaudeMd(config(root));

    expect(await read(root)).toBe(`- no trailing newline\n\n${POLICY_BLOCK}`);
  });

  it("is idempotent: a second start adds nothing", async () => {
    const root = await project();
    await ensureClaudeMd(config(root));
    const afterFirst = await read(root);

    const result = await ensureClaudeMd(config(root));

    expect(result.state).toBe("present");
    expect(await read(root)).toBe(afterFirst);
  });

  /**
   * The block is a starting point, not a managed region. Someone who tunes the
   * policy for their project must not find it reverted — or duplicated — the
   * next time the server starts.
   */
  it("leaves an edited block alone rather than restoring or duplicating it", async () => {
    const root = await project();
    await ensureClaudeMd(config(root));
    const edited = (await read(root)).replace(
      "- Escalate to yourself after 2 failed local attempts on the same unit.",
      "- Escalate to yourself after 5 failed local attempts on the same unit."
    );
    await fs.writeFile(path.join(root, CLAUDE_MD_REL_PATH), edited, "utf8");

    const result = await ensureClaudeMd(config(root));

    expect(result.state).toBe("present");
    expect(await read(root)).toBe(edited);
    expect((await read(root)).match(/local-coder:policy:begin/g)).toHaveLength(1);
  });

  it("recognises an older marker version, so an upgrade does not write a second block", async () => {
    const root = await project();
    await fs.writeFile(
      path.join(root, CLAUDE_MD_REL_PATH),
      "<!-- local-coder:policy:begin v0 -->\nold policy\n<!-- local-coder:policy:end -->\n",
      "utf8"
    );

    const result = await ensureClaudeMd(config(root));

    expect(result.state).toBe("present");
    expect(await read(root)).not.toContain("Verify with mcp__local-coder__gate");
  });

  it("refuses a directory that is not a project", async () => {
    const root = tempRoot(); // no .git, no package.json
    const result = await ensureClaudeMd(config(root));

    expect(result.state).toBe("skipped_not_a_project");
    await expect(read(root)).rejects.toThrow();
  });

  it("accepts a worktree, where .git is a file rather than a directory", async () => {
    const root = tempRoot();
    await fs.writeFile(path.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n", "utf8");

    const result = await ensureClaudeMd(config(root));

    expect(result.state).toBe("created");
  });

  it("writes nothing when the opt-out is set", async () => {
    const root = await project();
    const result = await ensureClaudeMd(config(root, false));

    expect(result.state).toBe("disabled");
    await expect(read(root)).rejects.toThrow();
  });

  it("reports failure instead of throwing when the path cannot be written", async () => {
    const root = await project();
    // A directory where the file should go: every write fails, nothing throws.
    await fs.mkdir(path.join(root, CLAUDE_MD_REL_PATH));

    const result = await ensureClaudeMd(config(root));

    expect(result.state).toBe("failed");
    expect(result.detail).toBeTruthy();
  });

  it("records its outcome for status to report", async () => {
    const root = await project();
    expect(getClaudeMdState()).toBeNull();

    await ensureClaudeMd(config(root));

    expect(getClaudeMdState()?.state).toBe("created");
    expect(getClaudeMdState()?.path).toBe(path.join(root, CLAUDE_MD_REL_PATH));
  });
});

describe("the opt-out env var", () => {
  it("defaults on, and reads the spellings people actually type", () => {
    const root = makeTempRoot("claude-md-cfg-");
    roots.push(root);

    expect(loadConfig({}, root).autoClaudeMd).toBe(true);
    for (const off of ["0", "false", "no", "off", "OFF", " False "]) {
      expect(loadConfig({ LOCAL_CODER_AUTO_CLAUDE_MD: off }, root).autoClaudeMd, off).toBe(false);
    }
    for (const on of ["1", "true", "yes", "on"]) {
      expect(loadConfig({ LOCAL_CODER_AUTO_CLAUDE_MD: on }, root).autoClaudeMd, on).toBe(true);
    }
    // Garbage keeps the default rather than being read as "off": a typo that
    // silently disables a side effect is the failure that is hard to notice.
    expect(loadConfig({ LOCAL_CODER_AUTO_CLAUDE_MD: "maybe" }, root).autoClaudeMd).toBe(true);
  });
});
