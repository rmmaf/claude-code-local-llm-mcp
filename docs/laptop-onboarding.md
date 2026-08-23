# The laptop track — onboarding for a session on the Windows laptop

You are Claude Code, in a fresh clone of this repository, on a **personal
Windows laptop** (Intel Core 5 210H, 16 GB RAM, RTX 4050 mobile). Read this
file before doing anything else. It exists because the work in this repo is
spread over three machines with different powers, and the fastest way to waste
a day here is to do work that belongs on another one.

## What this repository is

`local-coder`: an MCP server that gives Claude Code a set of local-model tools
(`gate`, `repair`, `scaffold`, `implement`) whose purpose is to **cut context
cost**, not to generate better code. The premise is that a local model can
absorb the bulky, mechanical work — running checks, looping on type errors —
so the expensive orchestrator never sees the output.

Wrapped around it is **B12**: a preregistered A/B experiment measuring whether
that saving is real. Its preregistration is frozen at
`evidence/2026-08-05-b12-preregistration.json`, its ledger of premises is
`PREMISES.md`, and its rule is the repo's whole culture: **measure before you
claim, label what is chosen, and let a refusal stand rather than paper over
it.** Read the last few entries of `PREMISES.md` before proposing anything.

## The three machines, and which work belongs where

| Machine | Powers | Owns |
|---|---|---|
| **Windows desktop** | git, GitHub, full dev, no LM Studio in the loop | authoring, review, reconciliation |
| **Work Mac (mac-01)** | unified memory, LM Studio with the 30B/14B, claude 2.1.221 pinned | **every B12 scored measurement**; git on weekdays only |
| **This laptop** | LM Studio + unrestricted Claude Code sessions, small models, discrete GPU | development, and a **separate lower-bound measurement track** |

## HARD GUARDRAILS — read twice

1. **Never push to `claude/b12-pilot-phase2`.** That branch is carrying a Mac
   pilot round that is *mid-flight*: the Mac holds two commits that were never
   pushed (an `installedChars` probe artifact and the filled
   `manifest-config.json`), and its resume gate requires an exact commit count
   and diff surface against the branch tip. Moving that tip can wedge a round
   that has already spent paid sessions. Work on your own branch:
   `git switch -c claude/laptop-<topic>`.

2. **B12 scored runs and the pilot WILL REFUSE on this machine, and that is
   correct.** `pinned.runToolchain` declares `darwin/arm64` and
   `assertRunToolchain` (`scripts/b12-run.mjs`) refuses before spending
   anything. The binary sha, the truncation cap, the `installedChars`
   calibration key and `.b12-mcp.json`'s absolute path are all Mac-bound too.
   **Do not "fix" these refusals by editing pins.** A pin that moves to suit
   the machine in front of you is the failure mode this design exists to
   prevent. If you believe a pin must change, write the argument into
   `PREMISES.md` and stop.

3. **Do not touch `scripts/b12-run.mjs` or `CLAUDE.md`.** Both are sha-pinned
   in `b12-corpus/manifest-config.json`; the pre-commit hook
   (`npm run pins:check`) will refuse, and rightly.

4. **Never use `LOCAL_CODER_MODELS_CSV` to pin a model.** That route is CLOSED,
   by commit `1eba3dc`, for a measured reason: it was once pointed at a file
   that did not exist, `loadModelCatalog` silently fell back to the built-in
   catalogue with a warning nobody read, and a MEASUREMENTS row recorded the
   catalogue that was *requested* instead of the one in force. The sanctioned
   route is to edit `DEFAULT_MODEL_CATALOG` in `src/models-csv.ts` and commit
   it — a catalogue inside the repository is reproducible from a commit; a
   path on somebody's disk is neither pinnable nor hashable.

## Why this laptop is worth having

Two things it can do that the work Mac cannot:

- **Unrestricted Claude Code sessions.** The work Mac carries ~30 claude.ai
  account connectors that cannot be removed, which is why both B12 arms run
  `--strict-mcp-config`. A clean personal install is a better place to develop
  against — and a *different* environment, so never mix its numbers into a Mac
  calibration key.
- **A lower-bound track.** See the premise below.

## The premise this track rests on — state it, do not assume it

**The owner's argument (2026-08-18):** if the tools produce good results with
*small* models here, larger models on the Mac will do at least as well.

**Where it holds:** this laptop is pessimistic on BOTH axes at once — a weaker
model AND a slower one (see Q2). So a laptop *success* is a genuine floor:
capability and throughput both improve on the Mac.

**Where it fails, and this is not hypothetical:** bigger models are SLOWER, and
B12's bars include time — `repair` carries a 300,000 ms budget,
`pinned.perArmTimeoutMs` is 45 minutes, and `scripts/b12-repair-pace.mjs`
exists precisely because "does the model reach its budget?" is an open
question. A small fast model can pass a bar a large slow one fails. The
implication runs one way only.

**Therefore:** this track produces **lower bounds and development evidence**,
never a substitute for a Mac measurement, and nothing it produces may be cited
as a B12 scored result. Label every artifact `laptop-01` and say which machine
it came from, as every other measurement in `PREMISES.md` does.

## The three open questions to measure FIRST, before building anything

These are unverified claims about this machine. Measure them, record what you
find, and only then decide what to build.

### Q1 — Is the `lms` CLI even reachable from the server on Windows?

`src/lms.ts:140` shells `run("lms", ["ls", "--json"])` with a **bare** command
name, while other call sites in this repo branch explicitly (`npx.cmd`,
`npm.cmd`, `git.exe` — see `src/checks/config.ts:183` and
`src/tools/repair.ts:305`). If LM Studio installs its CLI as `lms.exe` or a
`.cmd` shim, Node's `spawn` without a shell may not resolve it — **and the
failure is swallowed**: `lms.ts` catches, logs a warning, returns `null`, and
the system degrades to "sizes unknown / fits: null" instead of erroring. That
is a silent fallback of exactly the kind this repo hunts.

```
npm ci && npm run build
node -e "Promise.all([import('./dist/tools/status.js'),import('./dist/config.js')]).then(async ([m,c])=>console.log(JSON.stringify(await m.runStatus(c.loadConfig()),null,2)))"
```

Compare that output against `lms ls --json` typed directly in the same shell.
If they disagree, you have Q1's answer, and the fix belongs in `src/lms.ts`,
mirroring the `win32` branch the other call sites already use.

### Q2 — What actually fits, and is "fits" even the right question here?

**The finding that prompted this file:** `usableFree()` (`src/selection.ts:121`)
is `freeBytes × memFitFraction` (default 0.85), and **nothing in the memory or
selection path knows about VRAM**. On the Mac that proxy is sound because Apple
silicon has unified memory — free RAM *is* the GPU budget. On this laptop the
binding constraint is the RTX 4050's VRAM (verify the exact figure rather than
trusting the spec sheet), while `os.freemem()` (`src/memory.ts:52`, the
non-darwin branch) reports system RAM. So `selection` will call a 10 GB model a
fit, LM Studio will load it with partial GPU offload, and it will run at a
fraction of the speed — correct output, wrecked throughput, **and no signal
anywhere that this happened**.

Measure: VRAM total and free; `os.freemem()` at the same moment; then load one
model that fits VRAM and one that does not, and time an identical `repair` call
against each. The deliverable is a table of tokens/sec against GPU-resident
fraction. If the gap is large, the honest conclusion is that `selection`'s fit
rule is *unsound on discrete-GPU machines* and should either learn VRAM or
refuse to guess — write that argument up before implementing either.

Note both built-in catalog models are out of reach here regardless: 16 GB and
14.6 GB, against 16 GB of system RAM.

### Q3 — Can `repair` close a unit at all with a small model?

The lower-bound question, with a precedent worth reading first: **PHASE 3 of
B12 closed INCONCLUSIVE at 1 of 3 units** (`PREMISES.md`, search "PHASE 3"),
against its own pre-registered rule, by an owner decision taken knowingly.
`scripts/b12-scorer-mac.sh` is that harness — read it for the *shape* of the
experiment (three real units; a unit counts as closed only if `repair` returns
`passed:true` AND an independent vitest run exits 0), but do not try to run
that Mac script here.

A laptop version is legitimate new evidence: pick small coding models that fit
VRAM, add them to `DEFAULT_MODEL_CATALOG` (guardrail 4), and measure how often
`repair` closes a mechanically-red unit within its budget. Report
closed/attempted with the model, the quantization, the GPU-resident fraction
and the wall time — never a bare success rate.

## How to work here

- **Verify with `mcp__local-coder__gate`**, not by running lint/tsc/tests
  through Bash — one call, structured failures only. `CLAUDE.md` carries the
  full delegation policy; it is arm-neutral by design (both B12 arms read it),
  so do not edit it.
- **Do not delegate the building of local-coder to local-coder.** The product
  should not author itself: `gate` stays in the loop, `scaffold`/`repair` are
  not used on this repo's own source.
- **Review every step, planned or built.** Findings get adjudicated against the
  code, never accepted on sight. Recent history here is four review rounds
  finding 31 real defects before a single paid session was spent.
- **A refusal is a deliverable.** The first question is always "what is this
  check right about?", never "how do I get past it?".

## Where things stand as you arrive (2026-08-18)

- Branch `claude/b12-pilot-phase2` carries PHASE 2 of B12, prepared end to end:
  policy blobs, a memory snapshot, a byte-pinned MCP config, a three-phase Mac
  choreography (P1 measure → P2 seal → Q spend) and a one-command entry.
- On the Mac, P1 is green and P2 ran green through its five preflights: the
  model pin was decided from a live measurement (the 30B, which fit once RAM
  was freed), `installedChars` came back **SUSTAINED**, and two local commits
  landed. P2's final reporting step then refused on a one-line bug in its own
  checkpoint reader — it looked for `policyBlobs` at the JSON root instead of
  under `pinned`. The fix is committed at `87bb06e`; the Mac's next step is a
  fetch, a rebase, a P2 resume, and then the five paid pilot sessions.
- **None of that needs this laptop. Leave it alone.**
