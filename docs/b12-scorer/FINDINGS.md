# B12 scorer — open findings

Defects in the scorer's **specs and bodies**, not in the harness that measures
whether `repair` can author them. Kept here because the fix for each one moves a
spec, an oracle and a body together, and because a finding that lives only in a
conversation is a finding that gets rediscovered.

F1–F5 came from a Codex adversarial review on 2026-08-06, each verified by three
independent agents (factual / impact / adversarial-refuter, the refuter told to
default to REFUTED absent positive evidence); all 15 confirmed. F6–F8 were found
afterwards. **F9–F14 came from a second Codex adjudication on 2026-08-07**, run
as gate 1 of the scorer-correctness pass; every mechanism below was re-checked
against the files before being written down, and two of Codex's claims were
sharpened in the process rather than copied. **F19–F22 came from three more
rounds the same day**, and those went the other way: three of my own readings
were refuted, including a safety claim this file had already published (see F19)
and a resolution I offered by quotation with the qualifier dropped (F20).
**F23–F25 came from the gate on `UNIT-5.md`**, which returned REFUTE on the whole
spec — and F24 is the first finding here that blocks the project rather than the
scorer: a run executed today produces evidence that cannot be re-scored.

**None of these is a reachability blocker.** The four units' oracles pass green on
all of them — `coverage.ts` joined the three when the run-level ledger landed —
which is exactly why they need writing down: an oracle that cannot fail on a
defect is not evidence the defect is absent.

## Twenty-six findings, and only two of them are work

**F1–F26, one number per finding except F2, which split. F18 does not exist and
never did** — the numbering skipped it, and that is recorded here rather than
back-filled, because renumbering would break every citation in `git log`.

The count says less than the split does. **Nineteen are closed — F23 repaired
2026-08-09, in its own pass as its entry demanded, and F26 found and closed
the same day the audit computer pinned the control registry. Of the seven
open, one is code owed, one is a decision, and five will never close** — each of
those five is a place the frozen design underdetermines what an implementer needs,
every closing route was adjudicated and REFUSED, and what shipped is the literal
reading plus enough published detail that a reader of a committed artifact can see
the gap.

**So the open list is not a backlog, and reading it as one is the mistake this
section exists to prevent.** A registered limit still open on the day the scorer
is finished is the CORRECT state: closing one would mean amending a
pre-registration, which is the failure the whole apparatus was built against.
The three headings below say which kind each finding is, and nothing else about
this file changed.

The arrival pattern is worth as much as the count. F1–F10 were defects in the
scorer's own bodies and they stopped. F17 onward are all on the BOUNDARY between
the scorer and what surrounds it — the frozen text, the harness, the artifacts —
which is what a component looks like approaching done with its surroundings not
ready, rather than one decaying.

---

## OPEN — code owed

One — F24. The second, F23, was repaired 2026-08-09; its record stays below,
where every citation to it points, with the repair on the entry itself.

### F24 — the archive the assembler must read is not the archive the harness writes

**THE BLOCKER.** Found by the Codex gate on `UNIT-5.md`, 2026-08-07, and it is the
reason that spec is not implementable.

`design.artifacts` 6 defines `evidence/<run_id>/obs-<NN>/`, "committed at each
task's END, before the next task starts": the admitted records reduced to the
fields the meter reads for **every file in the lineage**; the telemetry rows in
the task's window **VERBATIM**, credited and refused alike; the pre/post
`requestId` diff; the observation's `invocation_id` set; the acceptance command's
exit code; and **sha256 of every source file**.

`scripts/b12-run.mjs` wrote four files when this was written: `observation.json`,
`snapshot-before.json`, `snapshot-after.json`, `cli-stdout.json`. **It emits six
now** — those four plus `archive.json` and `telemetry.jsonl` — and the commit
barrier checks all six blob by blob against `HEAD`. What the clause still owes is
below, not this.

**The archive is what makes the run correctable rather than only discardable.**
The frozen text says so in the same clause: `.local-coder/telemetry.jsonl` is
gitignored as per-machine and session transcripts live outside the repository and
are rewritten by the vendor, "so without this archive the VOID conditions' own
re-emission escape hatch cannot be exercised and the run cannot be corrected, only
discarded — which is character for character why B1 cannot be re-adjudicated."

So this is not a reporting gap. **A run executed today produces evidence that
cannot be re-scored**, which is the failure mode the whole design was written
against. The fix belongs to the harness, not to any scorer unit, and it has to
land before the first scored observation or the run it produces is the one that
cannot be corrected.

**A SECOND GATE, 2026-08-07, ADJUDICATED THE FIX BEFORE IT WAS WRITTEN AND FOUND
F24 IS NOT ONE GAP BUT A FAMILY.** Two of my four readings were refuted, the
count above was corrected against me, and four obligations nobody had counted
came out. Everything below is checked against the frozen text, not copied.

**The count was wrong in my favour and is corrected.** Four of the six are
absent, not four and a half: the pre/post `requestId` diff is **present in
full** — both complete snapshots are archived and `originatedRequestIds` is the
set difference, which is exactly what `unitOfMeasurement` defines ("any id absent
from the pre-snapshot was ORIGINATED"). It demands no deletion set.

**THE REDUCTION THE CLAUSE NAMES CANNOT REBUILD A `Transcript`, WHICH MAKES
ARTIFACT 11 UNSATISFIABLE AS WRITTEN.** The parenthetical is `requestId, uuid,
sessionId, type, model, usage, timestamp, isApiErrorMessage`. `readTranscript`
also needs `parentUuid` and `isSidechain` to build threads, `isCompactSummary` /
`compactMetadata` to find segment boundaries, `message.content` for `toolUse.id`,
and `toolUseResult` for result bytes and the invocation join. Without them there
are no threads, no segments, no positional multiplier and no provenance join —
so "recomputes … EVERY admission condition **from the committed archive alone**"
cannot be met from the fields the clause enumerates.

**Resolved by quotation, from inside the same clause.** It reads "the admitted
records reduced to **the fields the meter reads** (requestId, …)". The criterion
is *the fields the meter reads*; the parenthetical is an enumeration OF that
criterion, and it is incomplete against it — the meter demonstrably reads
`parentUuid` and `toolUseResult`. The criterion governs and the list is short.
Archiving the fields the meter actually reads applies the clause's own stated
rule rather than inventing one, and it is the reading that is "demanding on the
experiment, never permissive on the result" (`thresholdArgument`).

**Four more obligations, none of them in the six:**

- **`installedChars` is measured NOWHERE.** `TermsInput.installedChars` is "the
  wire JSON of `tools/list` plus the CLAUDE.md block", and `holdsIf` 6 requires
  `O_o` for every observation. Every occurrence in this repository is a test
  fixture at `3_700`; `cost-meter.test.ts` records an actual measurement of
  **15,227** in a comment. Only the harness can take it — at scoring time the
  worktree is gone and the server is not running — and it is ARM-DEPENDENT, since
  the control runs `--strict-mcp-config` and installs nothing. `tests/stdio.test.ts`
  already speaks `tools/list` to the server over stdio, so this is measurable.
- **`design.artifacts` 5 is incomplete too.** It wants the snapshot to carry
  "per-file sha256"; `takeSnapshot` returns `files: files.length` — a count, with
  no path list and no hashes.
- **The harness does not restore the memory snapshot**, which `design.artifacts`
  10 says it does, and records none of `design.covariates`' instruction hashes:
  "the in-repo CLAUDE.md, the out-of-repo per-arm policy blob, .claude/settings.json
  and settings.local.json, the MCP config passed, the tool allowlist actually
  visible in the system prompt, and the memory directory — hashed PRE and POST per
  session." **One of those seven is not measurable from outside the session** —
  the allowlist visible in the system prompt — and that is registered here rather
  than discovered on the day.
- **Artifact 10 also owes a machine-written run row** "whose `ts` is read from the
  system clock in the same command that writes it". ~~Nothing appends one.~~
  **SHIPPED:** `observe()` appends exactly that row to
  `evidence/<runId>.b12.runlog.jsonl` on every observation, its `ts` read from
  `stamp()` in the same command. What artifact 10 still owes is the memory
  snapshot restore, not the row.

**TWO DEFECTS FOUND IN PASSING, BOTH REAL, BOTH FIXED IN THIS SAME PASS** — so
they take no finding number of their own:

- **The acceptance result may not describe the commit the observation names.**
  `acceptance` runs in the worktree against the possibly dirty working tree;
  `endCommit` is `git rev-parse HEAD`. An arm that edits without committing —
  the ordinary case for `claude --print` — records an exit code earned on files
  no recorded commit contains. `accepted` is what separates a TASK from an
  ATTEMPT, so this is the discriminator resting on unrecorded state.
- **The treatment arm's default MCP config does not exist.** `observe()` falls
  back to `path.join(REPO, ".mcp.json")` and there is no such file. Without a
  valid config the server never starts, so there is no telemetry at all, and the
  arm exits nonzero — classified `exited_nonzero`, INVALID, rather than the
  legitimate zero-tool observation it resembles.

**THE ARCHITECTURE IS DECIDED BY `voidConditions` 5 AND NOT BY TASTE.** The
capture belongs in `src/cost/b12/`, compiled into `dist/`, and NOT in a new
`scripts/b12-archive.mjs`. Clause 5 freezes exactly "`src/cost/**`,
`src/telemetry.ts`, gate's or repair's telemetry emission, or
`scripts/b12-run.mjs`" after the first scored observation. **A helper at a path
the clause does not name could be edited afterwards without tripping the
source-drift VOID** — a hole in the frozen guard, opened by a file layout.
`b12-run.mjs` keeps the orchestration and the commit barrier.

**And the capture uses the PRODUCTION parser, not a third copy of B20's rule.**
`admittedRequestIds` in the harness is already a deliberate second copy, on the
stated premise that the script "must run before `dist/` exists". That premise
does not hold for `observe`: the preflight already fails without
`dist/cost/cli.js`, and the treatment arm's MCP server **is** `dist/` — an
observation cannot run without it. So `observe` may import `readTranscript`,
`lineagesOf` and `scopeTelemetry`, and the copy stays only for `snapshot`.

**SHIPPED 2026-08-07 — THE ARCHIVE HALF, AND F24 STAYS OPEN.**
`src/cost/b12/capture.ts` builds artifact 6 as a value: the lineage reduced to
`RawRecord`, the telemetry window verbatim with the archive path as its identity
source, the owned `invocation_id` set, and the end worktree hashed as a labelled
superset. `observe()` calls it after acceptance and before
`git worktree remove`, then STAGES, refuses on an empty index, COMMITS and
refuses again if `HEAD` does not carry the path — so "committed at each task's
END" is a fact rather than an intention. `takeSnapshot` gained artifact 5's
per-file sha256. The dead `.mcp.json` fallback is a refusal now. (This paragraph
named a `dirtyAtAcceptance` field; gate 2 replaced it, below, with two separately
named facts — `armLeftUncommitted` on the observation, recorded before the
end-state commit, and `dirtyAtCapture` on the archive, taken at capture time.
Both are reported and neither decides anything.)

**A SECOND GATE ON THE DIFFS RETURNED REFUTE, AND FOUR OF ITS HOLES ARE FIXED
HERE.** Both of the frozen quotations it turned on were checked before conceding
and both hold.

- **`accepted` was being earned somewhere no commit describes, and my first fix
  published the discrepancy instead of removing it.** `admissionRule` 3:
  "An observation whose acceptance predicate does not exit 0 **AT ITS END
  COMMIT** is `void(task_failed)`." Acceptance ran against the working tree while
  `endCommit` was `git rev-parse HEAD`, so on the ORDINARY outcome — `claude
  --print` edits and does not commit — the exit code described a state no commit
  contained. A `dirtyAtAcceptance` flag was the wrong answer: a hash inventory
  does not make an uncommitted tree into the named end commit. Refusing would
  have been worse, since it invalidates the ordinary case. **The harness now
  commits what the arm left, in the arm's own throwaway worktree, before
  acceptance runs** — which adds no rule and makes the frozen predicate
  evaluable. Whether the ARM committed its own work is still recorded.
- **The commit barrier's `ls-tree` check asked whether ANYTHING was under the
  directory.** An index-mutating `pre-commit` hook can drop `archive.json` while
  leaving `observation.json` staged: the add succeeds, the staged check succeeds,
  the commit succeeds with what is left, and the existence check succeeds. Every
  guard green, archive not committed. It compares each written file's BLOB HASH
  against `HEAD:<path>` now, and the file list is built as the files are written
  rather than maintained by hand beside them.
- **An empty lineage committed as a schema-complete archive.** Caught by
  comparing two numbers the harness already has: if ids were originated, a
  transcript carrying them exists, so an empty lineage means the search was
  scoped wrong. `classifyRun` already refuses the mirror image. No disposition
  and no threshold added.
- **`mcpConfigSha256` was compared only when present**, which makes the check
  disappear on exactly the manifest that needs it. `design.artifacts` 1 requires
  the manifest to carry it, so it is required.

**AND ONE HOLE IS NOT FIXED, BECAUSE FIXING IT WOULD MINT.** `voidConditions` 5
freezes `src/cost/**` and `scripts/b12-run.mjs`; it does not name `dist/**`, and
`design.artifacts` 1's manifest inventory does not list it either. **A
hand-edited `dist/cost/b12/capture.js` can fabricate or omit archive evidence
while every frozen source stays byte-identical** — which defeats the reason the
capture was put under `src/cost/b12/` in the first place. Requiring a manifest
pin for it would add an item to a frozen inventory. So both the compiled and the
source hash are RECORDED on every observation and the pin is compared when a
manifest carries one — the shape `assertRatesFrozen` already uses. **This is a
registered limit, not a fix**, and it is the first one that lives in the harness
rather than in the scorer.

**SHIPPED 2026-08-08 — THE HARNESS HALF.** A Codex gate on six frozen-text
readings ran BEFORE the pass was planned; three were refuted as written and the
corrections below are theirs.

- **`installedChars` is wired, with provenance, treatment arm only.** `observe()`
  resolves the committed probe artifact the manifest names and validates the
  calibration key COMPONENT BY COMPONENT against the live observation — binary
  sha256, treatment MCP-config hash, policy-blob hash (exact equality INCLUDING
  `null`: the committed probe pre-dates any sealed blob, so the first manifest
  that seals blobs refuses until a re-probe exists — the refusal is what keeps
  the re-take rule from being forgotten), and pinned `extraArgs`. Domain
  validation refuses absent/non-finite/negative at resolution AND at write time
  (`holdsIf` 6 cannot catch a fabricated finite sentinel; provenance at write
  time is the guard). **The control arm records a NAMED absence, never a
  value** — the gate refuted "control = 0, measured": the probe measured ONE
  delta and the control is the baseline inside that subtraction, so a control
  value (even 0) would be the two-valued `O` the ONE-`O_o` boundary refuses.
- **The per-arm policy blob is delivered** via `--append-system-prompt` from the
  manifest-pinned out-of-repo blob, hash required per arm (`voidConditions` 12
  makes its absence from any record a VOID), refused if it resolves inside the
  arm's worktree or exists in the base tree at the same path.
- **The memory snapshot is restored** before every session (`design.artifacts`
  10), asserted against the manifest pin, hashed pre and post; a post-hash drift
  is recorded as invalidity (`voidConditions` 13).
- **The seven instruction covariates are hashed pre and post** — the seventh,
  the allowlist visible in the system prompt, recorded as the registered limit
  it is, a named fact instead of a hash dressing an assumption as a measurement.
- **Manifest completeness refuses before anything spends**: `verificationStratum`
  (F25's route), `expectedSubagentStratum` and `promptSha256` (`design.artifacts`
  1 completeness — the latter was compared only-when-present, `mcpConfigSha256`'s
  old defect). The preflight reports the same checks red instead of exiting.
- Every new guard ships FIRING in `tests/cost-meter.test.ts`, on exported pure
  functions — the `classifyRun` precedent — including the positive control that
  a sustained ZERO delta is accepted (zero-measured ≠ zero-defaulted).

**TWO AMBIGUITIES REGISTERED BY THIS PASS, NOT RESOLVED** — both found by the
gate, both places where the frozen text names a comparison without defining its
operand, and where deciding silently would mint:

- **`voidConditions` 21 voids A/B pairs on "different instruction-set hashes"
  while the policy blob varies per arm BY DESIGN** (channel 5). Whether that
  hash includes the intentionally arm-varying blob is not defined. The harness
  records COMPONENTS only and mints no aggregate; the A/B pass must adjudicate
  before comparing. **The adversarial review sharpened the consequence, and it
  is recorded with teeth: until the composition is adjudicated, the pair-level
  void is not mechanically evaluable — comparing all components voids every
  pair (policy differs by design), excluding any invents a definition after
  pre-registration. So AN A/B RUN MAY NOT START before this adjudication is
  registered.** Deciding it inside a code diff was declined deliberately: the
  planning gate on this same pass ruled "the pass must not silently decide
  this", and a silent canonical hash would be the O-bracket's error shape —
  minted decision structure — one level down.
- **`voidConditions` 12 compares a pair's "MCP-config hashes" while
  `design.artifacts` 10 gives the two arms different argv** (`--mcp-config` vs
  none). Whether the clause compares the manifest's pin (identical by
  construction) or what each arm was handed (differs by construction) is not
  defined. The record carries BOTH — `mcpConfigPinned` and `mcpConfigPassed`,
  `null` on control as a named fact.

**A SECOND ADVERSARIAL PASS — CODEX REVIEW OF THE DIFF ITSELF — RETURNED THREE
HIGH FINDINGS; TWO ARE FIXED IN THE SAME PASS, ONE IS DECLINED AS CODE AND
REGISTERED ABOVE WITH ITS CONSEQUENCE:**

- **The probe trust boundary was OPEN.** With the path unconstrained and the
  sha compared-if-present, a fabricated working-tree JSON carrying
  `sustained: true` and copied hashes would have calibrated `O_o` for every
  treatment observation. Closed: the probe path must be repo-relative under
  `evidence/`, present in HEAD, byte-identical to HEAD's blob
  (`committedEvidenceCheck` — the commit barrier's own comparison, reused), and
  `installedCharsProbeSha256` is REQUIRED now. Fabrication requires committing
  the fabrication, which the append-only history records.
- **The completeness sweep was PARTIAL, and the omission decided outcomes.** A
  task with no acceptance predicate proceeded and archived `accepted: null`
  while remaining `valid` — unscorable under `admissionRule` 3 after the
  session was spent. `manifestDeclarationGaps` now sweeps artifact 1's FULL
  inventory: per task the acceptance predicate WITH its declared expected exit
  code (now consumed by `accepted` instead of a hardcoded 0), verification
  command strings, gate category, repair max_rounds, file scope, both strata,
  prompt + sha, base commit; run-level the version/binary/rates pins, the
  measured `clientTruncationCap`, both CHOSEN caps, the scoring command, the
  CLAUDE.md and settings hashes, the A/B pair list, and the harness's own
  sha256 — which `observe` now asserts against the RUNNING script, so an edited
  harness cannot drive a sealed manifest.
- The third finding — mint a canonical instruction-set hash for
  `voidConditions` 21 — is the ambiguity registered above, with the review's
  consequence recorded: no A/B before the adjudication.

**A THIRD ROUND, ON THE BRANCH DIFF, FOUND THE VALIDATOR TRUSTING THE SUMMARY
IT SHOULD RECOMPUTE — CONFIRMED AND FIXED.** `validateInstalledCharsProbe`
read only the artifact's own claims (`sustained`, `deltaTokens`), so a
committed JSON with matching hashes and a fabricated delta would have
calibrated every treatment observation — committing proves storage provenance,
not that the registered protocol produced the value. Now every derived number
is recomputed from the replicate records the artifact carries and any
disagreement refuses: exactly k = 3 replicates (the CHOSEN constant);
per-arm `promptTokens` re-derived from `input + cacheCreation + cacheRead`;
each arm's VERBATIM raw first record parsed and checked against the extraction
(usage, requestId, sessionId, admissibility); per-replicate model pairing; six
DISTINCT session ids (a reused id is a resumed session); deltas, `deltasTokens`
and `sustained` recomputed and compared against the claims; the protocol
reference (`preDeclaration` naming `PREMISES.md § B12`) and both argv shapes
(both arms strict, `--mcp-config` on treatment only) REQUIRED — the old
fallback that labelled missing provenance as the registered protocol is gone.
The committed artifact `2026-08-08-mac-b12-installedchars-50de3b3-144422`
passes the full recomputation (re-verified mechanically before shipping).
**The honest boundary, registered:** the artifact cannot prove the sessions
RAN — the transcripts do not travel in it; that burden stays with
committedness plus the archived raw records, which a reader holding the
transcripts can re-verify.

**A FOURTH ROUND FOUND TWO MORE — BOTH CONFIRMED, ONE WITH ITS SCOPE
ADJUDICATED DOWN:**

- **The pair list was present-not-validated.** `Array.isArray(abPairs)` let an
  empty or malformed list through. Now: at least 3 pairs (fewer can never
  validate — `voidConditions` 21 voids "fewer than 3 complete pairs remain"),
  unique pair ids, task references that exist, a declared per-pair arm order,
  and BOTH orders present — the necessary condition of any reading of "ABBA
  order"; the exact sequence pattern is deliberately NOT decided here, it
  belongs to the A/B pass and is blocked with the VOID-21 hash adjudication.
  **The reviewer's wider ask — make every `observe` invocation prove pair
  membership — was DECLINED against the frozen text:** primary observations
  are not pairs ("the control arm never enters the primary verdict",
  `admissionRule` 13; the A/B is post-verdict, `runPlan` PHASE 7). What IS
  enforced now: the PRIMARY arm's committed order (`voidConditions` 3),
  checked against the persisted runlog before a session is spent
  (`committedOrderViolation` — treatment rows only; duplicates left to
  `admissionRule` 12's scoring-time re-run adjudication).
- **Instruction drift was recorded but only two components invalidated.**
  Settings, settings.local, the passed MCP config and the policy blob drifted
  visibly (pre ≠ post) while `valid` stayed true. Clause 12's intra-arm text
  names only CLAUDE.md — but those components are what the clause compares
  ACROSS A PAIR, and an arm carrying two values has no well-defined hash for
  that comparison: invalidating makes the frozen predicate EVALUABLE, the
  end-commit fix's own argument. `instructionDriftReasons` now compares every
  component (null-to-hash transitions included) with a per-component citation,
  and each fires in a test.

**A FIFTH ROUND FOUND THE ORDER GUARD ENFORCING HALF ITS INVARIANT —
CONFIRMED, AND THE FIX ALSO CORRECTED AN OVER-STRICTNESS OF THE GUARD'S FIRST
SHAPE.** The monotonic half alone ("no already-ran task with a higher index")
let a FIRST run of task 2 start on an empty runlog: nothing had run "after"
it, nothing fired, and the session was spent on a run already void under
`voidConditions` 3. Now a first run requires EVERY predecessor executed (the
missing ones named in the refusal), plus the monotonic half. And in the same
edit, the opposite error went: the old shape refused a LATE RE-RUN of an
earlier task, but a re-run is not an order event — the committed order fixes
the sequence of FIRST executions, and `admissionRule` 12 governs re-runs with
no temporal clause; they pass the guard and are counted at scoring over the
same runlog. Both counterexamples and the re-run permission fire in tests.

**A SIXTH ROUND: A PATH-TRAVERSAL DELETE, CONFIRMED AS A CLASS; AND A
PROTOCOL-SEALING DEMAND, SPLIT.** `task.id` was interpolated into the worktree
path handed to a recursive delete — `../../target` escaped `.b12/` and erased
an unrelated directory before git ever ran. Fixed as the CLASS, not the
instance: `task.id` AND `runId` (which names `evidence/<runId>/…`) are held to
one safe-filename grammar in the completeness sweep, and the worktree path
additionally proves it is a direct child of `.b12/` before any `rmSync`. On
protocol sealing, the checkable pieces the REGISTERED method names shipped:
the proof session (the committed MEASUREMENTS row: "proof session showed
`mcp__local-coder__status` callable") must exist, have called the tool, and be
a SEPARATE session from the six replicates; `context.commit` — which script
produced this — is required provenance. The wider demands — the exact
registered prompt and a byte-exact argv template — were DECLINED as minting:
the pre-declaration fixes "identical but for the arm", not a prompt string,
and the artifact's own note says the argv is NOT byte-for-byte before a
manifest exists. The registered argv components stay pinned; the
sessions-really-ran boundary stays registered above.

**SHIPPED 2026-08-08 — THE UNIT 5 PASS: artifacts 7 and 11, through a plan
gate.** A Codex gate ran on the PLAN before a line was written — 14 verdicts:
4 CONFIRM, 5 REFINE (all conceded), 3 REFUTE (two conceded in form and defended
in substance, one conceded whole), 1 UNDERDETERMINED — and the adjudication is
in the plan file and summarized here where it changed the shipped shape.

- **The assembler exists**: `archive.ts` (impure — paths, git facts and the
  register in; a validated `RunArchive` value out; telemetry identity stamped
  ONCE, keyed on the archive path), `assemble.ts` (pure — dispositions, the
  committed-order replay, the archive-level clauses 2/7/8/9/11/12/13/14/19/20,
  `ambiguousIds` run-level, one `computeTerms` per attempt, `runCoverage`,
  `aggregate`), `emit.ts` (thin — writes BOTH artifacts even on a VOID, never
  commits). The parser gained its pure half (`transcriptFromRecords`) so the
  archive feeds the SAME rule the live read does — one rule, two feeders.
- **Artifact 7 ships wide**: per attempt, both-horizon terms, the per-row
  vector, the four-class ledgers, subagent share, requests-per-segment, rate
  keys, SHAs, the SEVEN instruction components pre/post with an EXPLICIT
  absence-of-aggregate marker (the VOID-21 registration, not a minted hash),
  both MCP-config facts, F20's dual-reporting inputs, and the pre-declared
  `A_o + S_o > 0` report per admitted observation (gate R8: counterfactual.json
  only — artifact 8's inventory is not a licence to enlarge result.json).
- **Artifact 11's replay runs the REAL path over a COMMITTED fixture archive**
  (`tests/fixtures/b12-run/` — test material, never evidence):
  `readRunArchive → assembleRun → emitRun`, the bracket, jackknives, `R_all`,
  `R_hi⁺`, strata and every admission condition recomputed by hand (gate S4
  refuted "wait for a real run"; the residue that IS still owed: no archive of
  a REAL run exists until one runs).
- **TWO REGISTERED CONVENTIONS, labelled on the artifact** (the
  `selection.basis` precedent): disposition-name precedence = the closed
  list's published order, with every fired predicate on the face (gate R4
  refuted "derived from the frozen text" — it is a convention and says so);
  a re-run's scored attempt = the LAST (`admissionRule` 12 archives both and
  publishes both fractions but never says which scores).
- **`voidConditions` 8 FIRES ON EVERY RUN, by design, until F23's pass** — the
  artifact carries two byte sums, not two brackets; an assembler that skipped
  the unimplementable half would publish "no void" over a condition it did not
  check (gate R6 CONFIRM).
- **The clause 4–6 audit is an INPUT** with its verdict and inputs on the
  face; `{ran: false}` yields `uncheckedClauses`, never "clean", and the
  pre-declaration (`PREMISES.md § B12`) now bars a final verdict without a
  committed audit (gate R7: `{ran:false}` alone cannot discharge the clauses).
  **The audit computer is a named blocker of a lawful run** — nobody has
  written it.
- **Found by the gate, fixed in the pass** (no own finding number): the obs
  directory `obs-<taskId>-<arm>` COLLIDES on a re-run, destroying what
  `admissionRule` 12 preserves — the harness now suffixes `-r<N>` and the
  scorer parses the same grammar back, round-tripped in the oracle.
- **F25 at scoring time, registered**: a declaration failure the preflight
  route cannot reach (hostile archive: `accepted` null with nothing else
  fired, an unreadable record, a missing `installedChars`) is reported by
  name in `declarationFailures`, the observation is never admitted (entailed
  by rules 3/8, not chosen), NO disposition is minted, and the run-level
  consequence falls out of clause 3's own arithmetic. **Registered limit:**
  such an observation has no terms, so it is absent from `R_hi⁺`'s "every
  observation" domain — the omission is published on the artifact rather than
  papered, and the frozen text supplies no disposition that could carry it.
- **Registered limit, verdict precedence**: when archive-level clauses fire,
  the run's `voidClause` names the FIRST in table order and the whole check
  table is published — the frozen text ranks voids nowhere, so the order is a
  labelled convention like the two above.

**AN ADVERSARIAL ROUND ON THE DIFF RETURNED FIVE HIGH FINDINGS — ALL FIVE
CONFIRMED, ALL FIVE FIXED IN THE SAME PASS.** One class, five instances:
evidence accepted uncommitted, or absence of evidence published as clean —
the probe trust boundary's shape, which F24's second round had already fixed
once. Each fix ships FIRING:

- **The audit input trusted any readable JSON.** A working-tree
  `{ran:true, verdict:"clean"}` would have certified clauses 4–6. Now the
  audit must be COMMITTED EVIDENCE at `evidence/<runId>.b12.audit.json` —
  in HEAD, byte-identical, non-empty `inputs` (`committedAuditCheck`, the
  probe boundary's own comparison) — and the pre-declaration names the path.
- **An absent runlog replayed as a followed order.** Zero rows returned
  "clean" while the archive held real attempts. Now every archived treatment
  attempt needs its machine-written row (artifact 10) and every row its
  surviving directory; either gap fires clause 2's check as unreplayable.
- **Corrupt/drifted telemetry still priced the surviving subset.** A suspect
  identity source now prices NOTHING: `telemetryIntact` false → no terms, an
  `integrityFailures` entry, and a fired artifact-6 integrity check — the run
  voids instead of scoring around the tampering.
- **Clause 19's id set was taken on faith.** The ambiguity universe derived
  from rebuilt transcripts is now compared per observation against the
  archive's SEALED `invocationIds` inventory; any missing or extra id fires.
- **Absent memory/instruction evidence read as clean.** Clause 12 fires on a
  record with no instruction hashes; clause 13 fires on a missing pin, a
  missing restoration hash, or missing pre/post memory hashes — unshowable
  is not clean, the same principle the audit seam applies to clauses 4–6.

**A SECOND ADVERSARIAL ROUND (the branch diff) RETURNED THREE MORE — ALL
CONFIRMED, ALL FIXED.** The first round closed the boundaries the pass had
ADDED; this one closed the boundary the pass had INHERITED: the commit
barrier proves the original WRITE, and nothing proved the REPLAY reads the
same bytes.

- **Observation evidence was read from the mutable working tree.** Editing
  `telemetry.jsonl` and `archive.json`'s copy CONSISTENTLY bypassed the drift
  check. Now one `git status --porcelain` spans the manifest, the runlog and
  every observation directory: a DIRTY path is positive evidence of tampering
  — the owning observation loses its terms (integrity route) — and
  UNSHOWABLE (no repository to ask) fires the committed-evidence check
  without fabricating a tampering claim: terms publish under the void,
  because the partial bracket is owed either way. The distinction is the
  registered shape: mismatch ≠ absence of proof.
- **The manifest's committedness never bound the BYTES.** A blob existing at
  the path proved nothing about the bytes parsed. `git show HEAD:<manifest>`
  is now compared byte-for-byte with what was read; inequality fires
  artifact 1 by name.
- **A JSON-valid `null` in an archived lineage crashed the emitter** —
  violating this unit's own "nothing throws to avoid producing an artifact".
  Resolved by the PRODUCTION parser's own rule for the same situation: a
  non-object record is dropped WITH A COUNT (`reduceRecord`/`skippedLines`
  do exactly this), reported, never fatal — end-to-end control: a hostile
  null still yields a committed-shaped result artifact.

**A THIRD ROUND RETURNED THREE HIGH — TWO CONFIRMED AND FIXED, ONE DECLINED
WITH ITS CITATION:**

- **CONFIRMED: the register was read from the working tree.** Manifests and
  results came from HEAD while `MEASUREMENTS.jsonl` came from disk — a
  locally deleted row made an abandoned run (clause 1's own VOID) vanish
  into a deciding-nothing discrepancy. Registration rows now come from
  `HEAD:MEASUREMENTS.jsonl`, the on-disk copy is compared (a named
  discrepancy when it differs), the file joined the committed-evidence
  sweep, and **discrepancies FIRE a clause-1 check**: a register that cannot
  be listed with confidence is the omission the clause calls "itself a
  VOID". One correction the fix itself needed: the three byte-compares
  (manifest, audit, register) normalise CRLF — autocrlf materialises an LF
  blob as CRLF on Windows, and byte-identity would have called every
  Windows checkout tampered; line endings are the one transformation git
  performs on checkout, so they are the one normalised away.
- **CONFIRMED: attempt allocation raced.** Exists-then-create let two
  `observe` processes claim one directory and overwrite each other's six
  files — destroying what `admissionRule` 12 preserves — and the runlog's
  read-concat-write LOST rows under concurrency, which the order replay now
  refuses whole runs over. The claim is a NON-recursive `mkdirSync`
  (`claimObsDir`: the filesystem hands the directory to exactly one caller,
  `EEXIST` tries N+1) and the runlog row is a single-line `appendFileSync`.
  A concurrent git commit still fails loudly on the index lock — the
  barrier's own refusal.
- **DECLINED: "derive clause 8's predicate and make a non-void verdict
  reachable".** That is F23 by its own entry — "a second full pass of the
  whole arithmetic … changes `B12Result` and belongs in its own pass with
  its own controls" — and the always-firing check was CONFIRMED by the plan
  gate (R6) and registered here, in STATE.md and in UNIT-5.md. The artifact
  structurally cannot carry two brackets, so the missing-evidence predicate
  is constantly true until F23 lands; a run-time probe of a compile-time
  shape would be theater, and nothing runs before F23 anyway.

**A FOURTH ROUND RETURNED TWO HIGH — BOTH CONFIRMED, BOTH FIXED. Both are
fail-open instances of the principle the pass had already registered three
times, found inside the fixes themselves:**

- **The freeze window was anchored at the WRONG END of the session.**
  Artifact 1 says "dated after the earliest session START"; the anchor was
  the first runlog row's `ts` — written at observation END — so a manifest
  commit DURING a long first session escaped the window entirely.
  `observation.started` (pre-execution, recorded all along, discarded by the
  narrower) is now preserved, and `earliestSessionStart` takes the MINIMUM
  across every start-preceding timestamp the archive holds (`started`, the
  pre-snapshot's `ts`, the runlog rows). Fail CLOSED: no trustworthy anchor →
  `manifestCommitsAfterStart` is null, and null FIRES artifact 1 — a freeze
  that cannot be shown held is not a freeze.
- **The rates check read clean with BOTH references unavailable — and its
  detail CLAIMED an identity nothing had shown.** With the frozen commit's
  blob unreachable and the manifest pin absent, any working-tree rates file
  passed. Now the check fires when the pin is absent, when the frozen blob
  cannot be read, or on any inequality among disk/pin/frozen — the detail
  names which, and "unverified pricing is not frozen pricing" is on the
  face.

**A FIFTH ROUND RETURNED ONE HIGH AND ONE MEDIUM — BOTH CONFIRMED, BOTH
FIXED. Both are the same class again: a trust check that reported instead of
refusing:**

- **Cross-wired evidence was scored under the directory's name.** An
  `observation.json` naming another task or arm than its directory only
  appended a diagnostic; the assembler then picked the manifest task from the
  DIRECTORY and priced the mismatched record's acceptance and telemetry under
  it — copied evidence could apply one task's result to another. Identity is
  now a binding: record↔directory (task, arm), record↔run (`runId`),
  record↔sealed archive (`archive.json`'s task, arm, session), each absence
  or disagreement setting `identityIntact` false — and a suspect identity
  prices NOTHING (integrity failure, no terms, the artifact-6 check fires,
  now labelled "archive integrity"). The runlog side binds too, in clause 2's
  replay: a row naming another run is foreign evidence, and per task the
  rows' sessions must equal the attempts' sessions as MULTISETS — count
  equality says every attempt HAS a row, the session binding says the rows
  are THESE attempts' rows. Codex also asked for a snapshot binding; the
  snapshot files carry no identity fields, and inventing one at scoring time
  would bind nothing — declined for that sub-part, harness-side stamping
  registered as future work, not minted here.
- **Clause 19 read clean with either side of the comparison ABSENT.** The
  check fired only when the pinned and actual commands both existed AND
  differed — an absent pin or an unsupplied invocation passed while the
  detail admitted the gap, a verdict bypass in waiting once F23 removes the
  always-fired clause 8. It now fails CLOSED: fired unless both values exist
  and are equal, the detail naming the absent side — an invocation that
  cannot be shown to be the registered one is not the registered one. The
  pure-suite default now supplies the matching invocation, because a CLEAN
  archive is one that can show its command, not one nobody asked.

**A SIXTH ROUND RETURNED TWO HIGH — BOTH CONFIRMED, BOTH FIXED; ONE
SELF-CAUGHT DIVERGENCE FIXED INSIDE THE SAME REPAIR ZONE:**

- **The worktree collided BEFORE the atomic claim could protect anything.**
  `claimObsDir` (third round) made the EVIDENCE naming atomic — but it runs
  after the observation executes, and until then every same-task/arm process
  shared one fixed `.b12/<task>-<arm>` path whose startup recursively deletes
  whatever sits there: a concurrent invocation destroyed THIS process's live
  worktree mid-observation, exactly the in-flight evidence the claim was
  built to preserve. The worktree path is now PROCESS-UNIQUE
  (`.b12/<task>-<arm>-<token12>`): still one safe segment under `.b12/`, so
  the containment wall holds unchanged; lineage capture, snapshots and the
  memory restore all derive the slug FROM the path, so a fresh path is only
  a fresh slug (verified against `projectSlugDirs` and `projectSlugDirFor`
  before shipping). Codex's "claim before the worktree" alternative was
  REJECTED with reasoning on the face: an early claim leaves an empty
  claimed directory in append-only `evidence/` on every mid-flight refusal,
  converting "a refusal costs nothing to discover" (the harness's own
  registered economics) into a permanent void at scoring time. The
  shared-index half: the evidence commit runs in the main repository, so the
  loser of an `index.lock` race now RETRIES bounded
  (`gitCommitEvidenceRetrying`, 5 attempts, non-lock failures still refuse
  immediately) instead of refusing an observation that already paid for its
  session. A true concurrent same-task test needs real sessions — registered
  below with the real run, not simulated here.
- **An archived binary with NO version or sha read as the pinned one.** The
  per-observation predicate fired only when pin AND archived value both
  existed and differed; with either archived field absent the archive-level
  check published "every observation matches" on no evidence. Fails CLOSED
  now: an existing pin with an absent archived side fires
  `void(version_drift)` naming the absence, and version and sha are compared
  INDEPENDENTLY — a drift in one is not permission to skip the other.
  Self-caught in the same lines: the scorer compared version by STRICT
  EQUALITY while the harness's own gate (`assertPinned`) records raw
  `claude --version` output and requires it to CONTAIN the pin — the
  stricter second rule would have false-fired on every lawful run, the
  two-implementations drift this repository documents. The scorer now
  replays the harness's registered comparison, with the raw-output negative
  control pinned in the suite.

**A SEVENTH ROUND RETURNED TWO HIGH — BOTH CONFIRMED IN THEIR CORE, BOTH
FIXED; TWO OF THE RECOMMENDED MECHANISMS DECLINED AGAINST THE COMMITTED LOG'S
OWN SHAPE:**

- **The register reconciled only one direction, and read its rows as if the
  log could not lie.** `collectRegister` destructured `{ rows }` and DISCARDED
  `parseJsonl`'s corrupt-line count; a non-object row and a non-string
  `run_id` were silently skipped; and the reverse direction both the
  docstring and the clause-1 check comment PROMISED ("a row with no
  manifest") was never implemented — a scrubbed manifest hid an abandoned
  run and restored its consumed attempt. Fixed with a pure core: `registrationRows`
  fires on every row whose MEMBERSHIP cannot be decided (corrupt lines,
  non-object rows, a `run_id` that is not a string), and
  `reconcileRegisterTraces` reconciles a run's TRACES — a
  `.b12.runlog.jsonl`, a `.b12.result.json` or an observation directory in
  HEAD's `evidence/` whose id has no committed manifest is a run the
  register cannot enumerate, one discrepancy per hidden run, with the
  committed repository's real neighbours (preflight reports, probes,
  telemetry, the preregistration) pinned as negative controls. Two of the
  recommended mechanisms were DECLINED with the committed history as the
  citation: the bare row-minus-manifest set difference (every one of the 237
  committed rows carries `run_id`, naming 59 measured runs, none of them
  B12 — the difference voids every future run against the repo's own
  append-only log) and duplicate-`run_id` rejection (multiplicity is the
  log's lawful shape — one row per metric per run, twenty-three under
  `2026-08-02-win-01`; registration is presence, not count). The row ALONE,
  every other trace also scrubbed, is a REGISTERED LIMIT stated in
  `collectRegister`'s docstring: the frozen clause pins no registration-row
  schema beyond "its run_id written", so that row is indistinguishable from
  an ordinary measurement row.
- **A manifest declaring one id twice priced the session twice while every
  check stayed clean.** The selection walks manifest ENTRIES and fetches the
  scored attempt BY ID, so a duplicated declaration admitted the same
  observation's terms once per entry — distorting the bracket and the
  per-task denominator share — while `taskById`'s last-wins collapse let
  POSITION silently decide which declaration governs. Fixed on both sides:
  the harness refuses a duplicated task id in `manifestDeclarationGaps`
  (pre-registration, before anything is spent under a contested id), and the
  scorer fires `design.artifacts 1 — task identity` in table order beside
  the manifest-blob predicate, walks each id ONCE in selection, reports a
  duplicated not-started task as ONE disposition row, and reports which
  declaration governs the observation as UNDECIDABLE through the F25
  declaration route — never defaulted to position. The metamorphic control
  is pinned in the suite: the duplicate entry may change no figure — one
  admission, one bracket, one disposition row, same `R` as the
  single-declaration archive.

**What F24 still owes, so the entry is not mistaken for closed:**

- **A re-probe of `installedChars` under the sealed policy blobs**, forced
  mechanically by the calibration-key refusal above the moment a manifest
  carries blobs.
- **The clause 4–6 audit computer** (see the UNIT 5 block above) — the input
  seam and the pre-declaration exist; the tool does not.
- **A REAL run's committed archive** for artifact 11's replay — the fixture
  replay exercises the full path; only a run can supply the real object.
- **Identity stamps on the snapshot files** (harness-side): the fifth round's
  binding covers `observation.json`, `archive.json` and the runlog because
  those carry identity; the snapshots carry none, so their binding waits on
  the harness writing one — a run-time change, not a scoring-time mint.
- **A concurrent same-task execution test** (harness-side): the sixth round's
  unique worktree path and commit retry are exercised by real sessions only —
  two live processes on one task/arm belong to the real run's protocol, not
  to a fixture that would prove the mock instead of the harness.
- **A registration-row marker** (operator-side): the seventh round's row-alone
  blind spot exists because the frozen clause pins no registration-row schema.
  The registration COMMAND is operator tooling, not frozen instrument — a
  marker field on future registration rows would make the row-alone direction
  decidable without touching the design. Until then the limit stands as
  registered.

**Two readings of mine were REFUTED and are recorded as refuted:**

- **"sha256 of every source file" does not resolve to a range.** I read it as the
  end worktree, against `endCommit` capturing nothing uncommitted. The reading of
  the TIME is fixed by the clause; the RANGE is not — the text nowhere equates
  "source file" with every regular file, every tracked file, `task.fileScope`, or
  the instrument's sources. Picking one as *the* scoring interpretation would
  mint. So the capture hashes a SUPERSET with `task.fileScope` labelled inside it
  and attaches no refusal to the extra material — extra evidence is not a new
  admission rule.
- **"the whole worktree telemetry file IS the window, with no ±60 s" was too
  strong twice over.** The location is not proven by this repository: the MCP
  server's root is its own `process.cwd()` (`server.ts:105` → `config.ts:172`)
  and nothing here proves what cwd the launcher supplies, so the harness must
  ASSERT the path rather than assume it — unconditionally in the preflight, which
  calls `gate` and `repair` by design. And the ±60 s window is not the harness's
  to remove: `admissionRule` 5 fixes it by hand, and it still runs at SCORING
  time over whatever array the assembler builds.

**That last point resolves the collision `UNIT-5.md` step 2 was heading for.**
Step 2 fixes identity on "the run's telemetry log, read once" and forbids
identifying the per-observation copies — **and there is no run-level log.** Each
observation writes into its own worktree and `git worktree remove --force`
destroys it, which is precisely why the frozen clause calls the archive the thing
without which "the run cannot be corrected, only discarded". The copies are not a
convenience; they are the only survivors. Identity stays global and
collision-free by keying on the ARCHIVE PATH as `source`: ordinals restart per
file, paths differ, so `JSON.stringify([source, ordinal])` is unique without
making concatenation order load-bearing. What step 2 actually forbids — restarting
ordinals inside a SCOPED SLICE of one source — is untouched.

### F23 — `voidConditions` 8 wants two BRACKETS and the artifact carries two byte sums — REPAIRED 2026-08-09

Found by the same gate. Unlike F24 and F25 this one is a defect in UNIT 3, not in
the assembler, and it was invisible until a spec had to promise clause 8 could be
satisfied.

Clause 8: "VOID if no `clientTruncationCap` was measured for the version that ran,
**or if the artifact does not carry both the capped and uncapped brackets**."

A *bracket* is fixed by `design.metric` in its opening line — "**THE SCORED
QUANTITY IS A BRACKET, NOT A POINT**" — and is `[R_lo, R_hi]`.
`B12Result.cappedVsUncapped` is `{ capped: number; uncapped: number }`, two sums
of row BYTE magnitudes over the credited rows. Two numbers, not two intervals.

**The two frozen texts describe the same artifact differently**, and this is the
usual shape: `design.metric` lists "the uncapped-vs-capped pair" among the things
"reported, deciding nothing", while `voidConditions` 8 makes brackets a condition
of not voiding. The stricter reading is also the one that refuses, and this
design's habit is to take the reading that is "demanding on the experiment, never
permissive on the result" (`thresholdArgument`).

Satisfying it is a second full pass of the arithmetic with the cap applied and
without — `poolRatio` over rows priced both ways at both horizons — which changes
`B12Result` and belongs in its own pass with its own controls. Not fixed here.

**REPAIRED 2026-08-09, in that pass.** The reading registered first, then the
arithmetic:

- **The registered reading.** A bracket is `[R_lo, R_hi]`, and detector 2 asks
  for THAT bracket "published both capped and uncapped" — ONE
  `uncappedBracket { rLo, rHi }` beside the capped pair, nothing else. No
  uncapped variant of `rHiPlus`, the strata, the recomputations, the hold or
  the deliveries exists, and `cappedVsUncapped` stays what `design.metric`
  says it is: a byte-sum pair on the face, reported, deciding nothing.
- **Summed from rows priced whole, never reconstructed from byte totals.**
  `CreditedLedgerRow` carries `unitsUncapped`/`unitsLoUncapped` — `signed`
  through the same multiplier and write component, with the `Math.min` absent —
  and `ObservationTerms` accumulates `sLoUncapped`/`sHiUncapped` in the same
  credited branch under the same narrow. `aggregate` publishes the bracket
  through the four-form `PricedForm` selector; the jackknife, strata and
  delivery figures keep the narrow `"lo" | "hi"` union, so a caller reaching
  for an uncapped recomputation is refused at compile time. `reinstate` zeroes
  all four sums together; `withoutLargestRow` removes the chosen row from all
  four while RANKING on the capped pair.
- **Clause 8 went LIVE.** Fires iff `!(Number.isFinite(cap) && cap > 0)` OR
  any of the four bracket bounds is not a proper finite number, evaluated on
  the CONSTRUCTED result — a VALUE check, because NaN survives every sum and
  serializes as `null` — and the replay tests assert the same truth table over
  the real serializer's bytes. The default assemble oracle now expects ZERO
  fired checks, with the default void owned by the arithmetic's clause 3.

---

## OPEN — a decision, not an implementation

One. Its candidate route now has shipped behaviour (below), but the finding
itself — an encoding gap in the frozen text — remains: a run that reaches the
gap at scoring time still has no legal outcome.

### F25 — the frozen text demands a declaration and supplies no disposition for its absence

Found by the same gate, against a resolution the first draft of `UNIT-5.md`
invented.

`admissionRule` 8 requires `verificationStratum` "declared per task before the
run", and `scripts/b12-run.mjs` does not write it — so the assembler joins it from
the manifest by `taskId`. The question is what happens when the join FAILS.

**A throw is not available.** `admissionRule` 1 makes every registered run owe a
committed result artifact carrying `scored` or the VOID clause BY NAME, from
registration onward. An exception produces no artifact, which is the one outcome
the design does not allow.

**And no member of the closed disposition list describes it.** `void(withheld)`
is fixed by `admissionRule` 5 to `provenanceUnavailable || ambiguous > 0`;
`void(execution_error)` is narrowly enumerated by clause 12 as a harness exit, an
unhandled exception, or a transcript ending with no assistant turn;
`void(task_failed)` is the acceptance predicate. A malformed manifest is none of
them.

So the frozen text contains an ENCODING GAP: it mandates the declaration, mandates
a named disposition, and provides no name for the case where the declaration is
missing. **The first draft resolved it by inventing a throw, which is both a
minted rule and the one handling `admissionRule` 1 forbids.**

**A THIRD ROUTE EXISTS AND IS NOT YET ADJUDICATED — recorded as a candidate, not
as a resolution.** Every route considered so far tried to answer the question at
SCORING time, where `admissionRule` 1 has already attached. It attaches "from
registration onward", and the manifest is sealed and hashed BEFORE the first
billed request (`design.artifacts` 1). So the harness's preflight can refuse a
manifest in which any task declares no `verificationStratum` — before any run is
registered, before clause 1 binds, and while nothing has been spent. That mints
no rule: `b12-run.mjs`'s own contract is that "a precondition that cannot be
checked is a hard exit, never a warning", and this precondition is checkable by
reading the file. It does not close the finding as stated — a manifest could
still be corrupted between sealing and scoring, and its hash is what catches that
— but it makes the gap unreachable on a compliant run. **It belongs to the same
harness pass as F24 and is gated with it.**

**THE ROUTE SHIPPED 2026-08-08, `verificationStratum` AND ONLY THAT.**
`manifestDeclarationGaps` in `scripts/b12-run.mjs`: `observe` refuses a manifest
in which any task declares no `verificationStratum` before anything is spent,
and the preflight reports the same check red. The Codex gate on this pass
refuted a wider claim — the neighbouring refusals (the FULL `design.artifacts`
1 inventory, from the acceptance predicate to the harness's own sha, swept by
the same function after the adversarial review found the partial list decided
real outcomes) ship beside it as artifact-1 completeness, an extension of this
route's SHAPE by analogy, and are not attributed to F25.
The timing constraint is honoured in the code's own comment: the
no-minted-disposition argument holds only before registration, and hitting the
refusal on a registered run does not erase the owed `result.json`. **The finding
stays OPEN as stated**: the encoding gap in the frozen text is unreachable on a
compliant run now, not closed.

**THE SCORING-TIME BEHAVIOUR IS REGISTERED TOO, 2026-08-08 (the UNIT 5 pass),
because a hostile archive can still reach the gap.** The plan gate refuted
leaving it as an implementation convention. What `assemble` does, registered
here rather than implied by code: the observation is reported by name in
`declarationFailures` (F25 cited), it is never admitted — entailed by
`admissionRule` 3 (a task is scored only against its committed predicate) and
8 (the declaration is required), not chosen — NO disposition is minted, no
throw occurs, and the run-level consequence follows from clause 3's own
arithmetic. A PRESENT-but-corrupt stratum string keeps its terms and flows
through `partitionByStrata.unknownStratum`, the shipped defence in depth. The
gap itself remains exactly as stated above: OPEN, an encoding gap in the
frozen text.

---

## REGISTERED LIMITS — recorded, not closeable by implementation

Five. None is a defect. Each ships the literal reading of a frozen text that
underdetermines what an implementer needs, plus enough published detail that a
reader of a committed artifact can see the gap for themselves. They stay here
permanently.

**EIGHT CLOSING ROUTES WERE ADJUDICATED ACROSS THE FIVE AND ALL EIGHT WERE
REFUSED**, one of them twice. Enumerated so the count is checkable rather than
impressive:

| finding | route offered | why refused |
|---|---|---|
| F20 | `admissionRule` 6 says such an observation "is admitted" | an equivocation — the clause reads "to the FALL arithmetic only" |
| F20 | publish BOTH readings on `result.json` | permitted, but owed by the replay emitter, not by artifact 8 |
| F20 | return `open` when the two readings disagree | `open`-on-undecidability has three NAMED precedents, which is evidence against a general principle — and it would route around attempt consumption |
| F21 | require 5 hold-eligible observations per cell too | mints a second PREDICATE over a different population; **refused twice** |
| F17 | amend the preflight to screen `R_hi⁺`'s refusals | the preflight is a frozen artifact (see F11's rule) |
| F11 | allocate `O` across deliveries, or publish `R_installation` | changes the ESTIMAND, which B20's repair rule does not license |
| F13 | amend the design so `R_other` has a source | same rule as F11 |
| F13 | instrument the five silent tools | a design change wearing an implementation's clothes — it would CREATE data the experiment assumed existed, and would not close F11 anyway |

### F20 — which sense of "excluded" the selection guard takes is UNDETERMINED

Raised by the third F19 adjudication on 2026-08-07, against a resolution I
proposed and could not defend.

`selectionOf` splits admitted from excluded on DISPOSITION alone. `voidConditions`
16 and `holdsIf` 5 both compare "the EXCLUDED observations" against "the ADMITTED
set", and after F19 an observation can be admission-admitted and hold-excluded at
once. Nothing in the frozen text says which sense those two comparisons take.

**My attempted resolution was an equivocation and is recorded as one.** I argued
that `admissionRule` 6 says such an observation "is admitted", so clause 16's
"admitted set" covers it. The clause actually reads "is admitted **to the FALL
arithmetic only**" — domain-qualified, and I had quoted it with the qualifier
dropped. `conflictsResolved` 5 repeats the same two-domain split and likewise
assigns the observation to neither side of clause 16's comparison.

**Left on the disposition split, and that is an implementation convention rather
than a reading of the design.** Stated in `decideHold` and here so it cannot later
be cited as what the frozen text required. Moving the clause-6 exclusions to the
excluded side would add their `wouldHaveAdded` to `excludedWouldHaveAdded` and
remove their `S_o` from `admittedSumS` — both directions of one comparison at
once, so not even the direction is obvious.

**SHIPPED 2026-08-07: the convention is now on the artifact, not only in a
comment.** `B12Result.selection.basis` is the literal `"disposition"`, so a reader
of a committed `result.json` can see which extension of "excluded" produced the
numbers a void was built on. A label, not a guard — nothing compares it, and the
assertion that pins it is recorded in the oracle as not being a control.

**TWO ROUTES WERE ADJUDICATED AND BOTH REFUSED**, so the finding stays open:

- **Publishing BOTH readings is not required.** I argued `design.artifacts` 11 —
  "An admission rule the artifacts cannot replay is unfalsifiable after the fact"
  — forces it, since one `selection` block cannot let a reader replay clause 16
  under the other reading. REFUTED: replay means reproducing the rule actually
  applied, and replayability cannot manufacture a semantic choice the text never
  made. It is PERMITTED as "reported, deciding nothing" — but the per-observation
  inputs belong to `counterfactual.json` (`design.artifacts` 7), not to
  `result.json` (artifact 8, the narrower inventory this type maps to). **So the
  dual reporting is owed by the counterfactual/replay emitter, which nothing
  writes yet**, and is recorded here as owed rather than bolted onto `B12Result`.
- **Returning `open` when the two readings disagree is an amendment.** It mints no
  constant, and `open`-on-undecidability has three precedents — but each is
  NAMED, and that specificity is evidence against reading `open` as a general
  principle. Worse, clause 16 says "VOID (never a fall)" and `voidConditions` 23
  makes every non-enumerated void consume an attempt, so the rule would also
  create a route around attempt consumption. Refused.

### F21 — a hold cell can be evaluable on five observations and priced on three

`holdsIf` 3 wants "All four declared strata evaluable (≥ 5 **admitted**
observations each) and all four on the same side of 30%", and `admissionRule` 8
defines the floor in the same words. `admissionRule` 6 moves only the arithmetic.
So the floor counts admitted observations and the ratio does not, and a cell that
clears five admitted may be priced over as few as NONE — at which point
`poolRatio` returns 0, the cell fails the 30% conjunct, and the hold is refused.
That last step is the only thing keeping the gap from being dangerous, and it is
`poolRatio`'s empty-set guard rather than anything in this rule.

**The obvious guard is refused, and the refusal was re-tested against text I had
not read the first time.** Requiring five hold-eligible observations per cell as
well is monotone-conservative — after the fall branch it can only turn a hold into
`open`. `design.thresholdArgument` even says "**5** — the per-stratum and
per-delivery floor. B20's own set floor, taken unchanged", so applying it again
would mint no fourth constant. **REFUTED TWICE ALL THE SAME**, and the second
answer is sharper than the first: *"Applying five again would not mint a fourth
constant, but it would mint a second PREDICATE over a different population."*
`holdsIf` 3 and `admissionRule` 8 both name the population — "≥ 5 ADMITTED
observations each" — and "per-stratum" describes the floor's scope, not every
population later used to price that stratum. The literal reading ships.

**SHIPPED 2026-08-07: every cell now publishes BOTH its populations.**
`StratumCell` is `Evaluable<number> & { counted, priced }` — an intersection, so
`.evaluable` still narrows, no existing reader changed, and the counts survive on
BOTH unevaluable branches — the 5-observation floor and the corrupted declaration
— which is where a reader most wants them. `counted` is the cell's size in the
FLOOR partition and `priced` its size in the RATIO one. Not "the population that
decided evaluability", which this said first and is false on the corrupted branch:
there the cell is unevaluable because `unknownStratum` is non-empty, whatever its
own size. On the published face the two coincide; on `hold.strata` they are ten
and four.
A bracket resting on four observations was previously indistinguishable from one
resting on ten, because a cell was an `Evaluable<number>` and nothing else.

**Reported, deciding nothing.** Neither count is compared with anything, which is
the whole point: the gap is now visible on every artifact and is still open.

The exposure is bounded at the degenerate end only. `poolRatio` returns 0 for an
empty cell, which then fails the 30% conjunct — but that is an implementation
guard, not the frozen design handling the case, and it does nothing when one to
four hold-eligible observations produce a ratio above 30%.

### F17 — the frozen preflight screens for none of `R_hi⁺`'s new refusals

Raised by the second adjudication on 2026-08-07, against a claim I had made and
could not support: that a clean run trips none of the five conditions F9 and F12
added to `rHiPlus`.

`design.artifacts` fixes what the preflight asserts — `provenanceUnavailable ===
false`, `ambiguous === 0`, `unmatched === 0`, `excludedForeign === 0`,
`savedFraction !== null`, non-zero snapshot counts. It asserts **nothing** about
`unverifiable`, about unique window ownership, about credited rows no window
owns, about slices disagreeing, or about full slice coverage. And
`savedFraction !== null` excludes only `provenanceUnavailable` and `ambiguous`;
`buildCounterfactual`'s withholding rule deliberately does not withhold it for
`unverifiable`. (This paragraph cited `report.ts:1240` and was already off by
nineteen lines — see the stale-citation note below.)

So a run can pass its ten-minute preflight and still return `open` at scoring
time on a condition the preflight never looked at. **That is the safe direction**
— `open`, never a wrong fall — but it is a cost, and it is registered here rather
than discovered on the day it happens. The preflight is a frozen artifact and is
not amended; see F11 for the rule.

### F11 — `Σ_d R_d + R_other = R` is false, and the oracle hides it

The frozen design asserts the identity and `B12Result.identityHolds` says
"compute it; do not assume it". Computing it gives `false` on every real run:

```
Σ_d R_d = S / (A + S)        R = (S − O) / (A + S)        difference = O / (A + S)
```

`O` is non-zero by design — `holdsIf` 6 requires `unitsAddedByInstallation`
computed for every observation. `tests/b12-aggregate.test.ts`'s identity fixture
passes only because every `terms()` in it leaves `oO` at 0.

Fixing it is a **design decision, not an implementation one**: the installation
term has to be allocated across deliveries, or published as its own
`R_installation`, and the frozen design says neither. `UNIT-3.md` now instructs
the implementer to build the common denominator and let `identityHolds` come out
false rather than to force the identity.

**DECIDED 2026-08-07: implement to the instruction; do not amend.** B20's rule
lets the INSTRUMENT's implementation be repaired until the first scored
observation — it does not license changing the ESTIMAND, which is what
reallocating `O` would be, however early. `B12Result` carries `identityHolds` as
a boolean because the design's author allowed it to be false; forcing it true
deletes the evidence. The reading is pre-declared in `PREMISES.md § B12` so it is
not later mistaken for a measurement. A coherent per-delivery decomposition needs
a newly pre-registered premise.

### F13 — `R_other` has no source data at all

`UNIT-3.md` scores `R_other` over "the five unexercised tools" — naming none of
them, but the server registers seven and two are `gate` and `repair`, so the five
are `fix`, `implement`, `models`, `scaffold` and `status`. **None of those five
writes a telemetry row.** The only `telemetry.record` calls in the repository are
one in `gate.ts` and two in `repair.ts`. Separately, `isLocalToolResult` in
`report.ts` matches only `/(^|__)(gate|repair)$/`, so even a row from one of the
five would join nothing and land in `excludedForeign`.

So `R_other` is `unexercised` by construction on every run that can be produced
today, and the `Σ_d R_d + R_other = R` identity of **F11** cannot even be formed.

**DECIDED 2026-08-07: publish `unexercised` and declare it in advance.** Neither
of the two alternatives survives. Amending the design changes the estimand (see
F11). Instrumenting the five tools is a design change wearing an implementation's
clothes — it would CREATE data the experiment assumed already existed — and it
would not close F11 anyway, since the missing `O/(A+S)` is untouched by it.
`unexercised` is the design's own state for a delivery nobody exercised, and it
is neither a hold nor a fall.

### A stale citation in the frozen design, recorded because it cannot be fixed

`admissionRule` 5 cites `savedFraction` at `report.ts:684`. **This note said
`report.ts:1098` and that was wrong too by the time anyone read it** — 1098 is
inside the ambiguous branch of `buildCounterfactual`, not the withholding rule.
The rule is the `savedFraction:` property of `buildCounterfactual`'s return,
`provenanceUnavailable || ambiguous > 0 ? null : ...`, at `report.ts:1259` today.

**Cited by its text from here on, not by its line.** Three line numbers for one
expression in two days is the whole argument: a citation that has to be re-checked
every time the file moves is a citation nobody re-checks. The pre-registration is
frozen and stays as written.

### THE PILOT'S "No units" READING — registered 2026-08-09, BEFORE any pilot ran

`design.artifacts` 4 demands the covariate vector AND says "No units, no
bracket" — and the frozen covariate list itself contains unit-VALUED
quantities (per-row byte deltas, an excluded observation's `A_o`,
`unitsAddedByInstallation`). The two cannot both be read literally, and the
gap had to be adjudicated before the first pilot rather than inside it.

**The registered reading: "No units" forbids AGGREGATES — any A/S/R sum, any
bracket, any verdict — never the per-observation unit-valued covariates the
list demands.** The rationale is artifact 4's own: the pilot is "mechanically
incapable of optional stopping" because "the verdict command cannot produce
[a bracket] on fewer than the manifest's N" — what must not exist is anything
a stopping decision could read, and a per-row byte count decides nothing while
an aggregate is precisely what would. Encoded with teeth: `assertPilotShape`
(`scripts/b12-run.mjs`) refuses every aggregate/bracket spelling at any depth
on every pilot write, and the negative controls hold it there.

### THE "per-task DENOMINATOR share" FORMULA — registered 2026-08-10, BEFORE the seal

The frozen name (`thresholdArgument`) is "per-task DENOMINATOR share", and the
metric's denominator is `A + S` (`aggregate.ts`'s `poolRatio`: `(S + refused −
O) / (A + S + refused)`) — but `assemble.ts` computed `aO / Σ aO`, a share of
A alone (the seventh adversarial round, finding 12). Adjudicated before any
seal, never inside a run:

**The registered formula: `share_t = (A_t + S_t,lo) / Σ_admitted (A + S_lo)`
— the task's share of the metric's OWN denominator, on the DECIDING lo
horizon** (the same horizon `aPlusSPositive` registers one field above, and
the one the per-task recomputation in `aggregate.ts` already uses). The
manifest's `perTaskDenominatorShareCap` (0.25 — one of the two CHOSEN
constants artifact 1 requires, beside `pacingCacheWriteShareCeiling` 0.9)
stays a DECLARED covariate: reported beside the share, deciding nothing — a
live predicate here would mint a void the frozen text never wrote. Encoded
with teeth: the unequal-S test in `tests/b12-assemble.test.ts` pins two
observations whose A-only shares and registered shares disagree, hand-derived.

### PASSE C SUPERSESSIONS — dated 2026-08-10

Two 2026-08-08 shapes recorded above are superseded (the old text stays as
the record of when it was true):

- **The policy blob is no longer a live file beside a hash map.** The
  manifest seals GIT PROVENANCE — `{repo, commit, path, sha256}` per arm —
  and delivery reads the policy repo's object store (`git cat-file blob
  <commit>:<path>`), so no working-tree file exists to move mid-arm at all.
  Missing clone (the bundle-transport step, named), shallow clone,
  unreachable commit or path, non-UTF-8 bytes and a moved hash are each their
  own refusal; the in-base-tree shadow check retired with nothing left to
  guard, and the pre/post instruction hash re-reads the object store (drift
  there means the STORE moved).
- **The calibration key's policy-blob component is DUAL** —
  `policyBlobSha256s {treatment, control}` — because BOTH arms deliver their
  own blob via `--append-system-prompt` inside the measured delta. The
  committed 2026-08-08 probe artifact carries the singular pre-dual key and
  can never calibrate a registrable manifest again; the validator refuses it
  BY NAME, and the Mac re-probe under the sealed blobs is on the calendar
  beside the new `clientTruncationCap` probe
  (`scripts/b12-truncationcap-probe-mac.sh`, voidConditions 8's measurement).

### POST-IMPLEMENTATION ADVERSARIAL ROUND (R8) — adjudicated 2026-08-10

Codex reviewed the full branch diff (38 files) and returned two high
findings, BOTH confirmed against the repo and fixed with controls:

- **R8#1 — the CAS was unusable from a linked worktree.** `casCommit` built
  its temporary index at `path.join(repoRoot, ".git", ...)`, but in a linked
  worktree `.git` is a FILE pointing at the per-worktree git dir — every
  `read-tree` failed (fail-closed, but the register could never act from the
  layout this repo itself uses). The index location now comes from
  `git rev-parse --absolute-git-dir`; the control registers from a real
  `git worktree add` checkout and asserts the premise (`.git` is a file).
- **R8#2 — validation ran OUTSIDE the state the CAS captured.** `register`
  validated via a disk/HEAD `runCheck`, then re-read the candidate bytes,
  then captured `expectedHead` — so a disk edit could swap a validated
  manifest before the read, and a commit landing before the capture became
  the accepted baseline unchecked. The header's own promise ("captured ONCE",
  "OLD inputs from `<expectedHead>:<path>`") was not what the code did. The
  act is now `registerRun`: capture `expectedHead` and the candidate buffers
  FIRST, validate exactly those (pilot, seal, harness and MEASUREMENTS read
  from `<expectedHead>:<path>`; an on-disk-only pilot is refused by name),
  and pass the SAME buffers to the CAS — any later ref movement fails
  `update-ref`, so every race is fail-closed. `open-b` got the same
  capture-first reordering. Controls sit in the exact window (`afterCapture`
  seam, CLI never passes it): a disk mutation between validation and the act
  registers the VALIDATED bytes; a concurrent commit fails the CAS with
  nothing installed. `check` remains the DISK preview, documented as such.

---

## CLOSED

### F26 — clause 6's FIRST control had no test anywhere, and only the registry noticed — FIXED 2026-08-09

`voidConditions` 6 names six negative controls that must be "shown FIRING" in
the conformance suite. The audit computer's `CONTROL_TESTS` registry
(`src/cost/b12/audit.ts`) pins each one to an exact vitest fullName — copied
AFTER the tests exist, per the plan's own rule — and the copying is what found
this: **"a failed repair row crediting zero units" had NO satisfying test** in
either named file. Seven adversarial plan rounds had counted the missing
controls at two (the two-worktree fixture and the slug-coverage predicate);
the third absence survived them all because every near-miss LOOKED like
coverage — the turn-collapse control credits a repair row at exactly zero for
a DIFFERENT reason, and the scoring-seam test carries the abort row's shape
but asserts no units. A content-level sweep of both files against each frozen
control description, not the titles, is what separated them.

Closed the same day: `tests/cost-meter.test.ts` now carries "credits a failed
repair row at zero units — clause 6's failed-repair control" — the abort row's
exact shape (`bytes_raw: 0, bytes_returned: 0`, `detail.aborted`), CREDITED at
exactly zero units, never a refusal, never a closure. The registry's other
adjudications, recorded so the mapping is citable: control 2 = "keeps a call
that ADDED bytes as the negative it is"; control 3 = "counts a refusal it
cannot size instead of summing the unknown as zero" (the null observable
through the `unsized` channel, never summed as zero); control 5 = "refuses a
call whose invocation id two sessions both carry, on both sides".

### F19 — the hold arithmetic was scored over observations the rule bars from it — FIXED

`admissionRule` 6: "An observation with `ambiguous > 0` is admitted to the FALL
arithmetic only, at both bounds, and **excluded from the HOLD arithmetic**."
`aggregate` passed the whole admitted set to `poolRatio`, `strataCells`,
`deliveryScore` and `recompute` alike.

**THE RUN HAS TWO DOMAINS.** The published bracket stays over the full admitted
set — `conflictsResolved` 5 records the resolution as "admitted to the FALL
arithmetic at both bounds and excluded from the HOLD arithmetic", and `fallsIf`
reads `R_lo` by name — while `B12Result.hold` carries `R_lo`, three
recomputations, four cells and `R_gate` over the domain clause 6 leaves. They are
the same numbers on every clean run, which is why the divergence is pinned by
seven controls rather than by a comment.

**THIS FINDING'S OWN SAFETY CLAIM WAS FALSE AND IS CORRECTED HERE RATHER THAN
DELETED.** It read: "Such an observation carries its full `A_o` while its
ambiguous rows are refused, so its `S_o` is deflated — it drags `R_lo` DOWN,
making a hold harder." That confuses *deflated relative to its own counterfactual*
with *below the pool*. Removing an observation `(a, s, o)` from a ratio of sums
raises the pool **iff** its local ratio `(s−o)/(a+s)` is below the pooled one, and
a positive refused magnitude does not establish that. So the direction was never
conservative and never established — which means the hold branch shipped in the
F14 pass on a justification that did not hold. Refuted by the first adjudication
of 2026-08-07 against a claim I had written.

**What does bound the direction is `R_all`, and only because of Reading D below.**
Writing `S_x` for the excluded observations' saving, `hold.rAll` is
`(S_e − O)/(A_e + A_x + S_e)` against a published `R_lo` of
`(S_e + S_x − O)/(A_e + A_x + S_e + S_x)`; for `S_x > 0` the first is strictly
smaller. So a hold now requires the full admitted set to clear 30% under
dilution too, and the fix can only make a hold HARDER — **for `S_x > 0`, stated
with the qualification F1 and F9 both had to be corrected to make.**

Three forks were adjudicated and two went against me:

- **Does a short hold set make a hold impossible?** I read `holdsIf` 1's "over ≥
  20 admitted observations" as attaching to the figure, which would have made any
  ambiguous observation fatal to a hold and collapsed the whole fix to one
  conjunct. REFUTED: clause 6 calls the observation admitted, and "excluded from
  the HOLD arithmetic" presupposes an arithmetic it is excluded from. The hold
  legitimately runs on fewer than 20.
- **What does the hold's `R_all` reinstate?** Reading D: the clause-6 exclusions
  rejoin it at `saved_o = 0` with their billing intact. `admissionRule` 3 uses
  "dropped" to mean dropped from the hold arithmetic — a `void(task_failed)`
  observation is "dropped from the hold arithmetic ... and reinstated at
  `saved_o = 0`" — and `holdsIf` 2 asks a hold to survive "reinstating everything
  it dropped". The literal alternative takes a billed denominator off the hold
  side, which is the one direction a dilution guard must not move.
- **Is the predicate the owned ledger?** No, and this finding proposed that it
  was. `admissionRule` 5 pins `ambiguous` to the shipped counter, which
  `report.ts` increments over the whole telemetry slice **before** ownership is
  decided; ownership is imposed later, in `computeTerms`. The predicate is
  `refusals.ambiguous.count + unattributedRefusals.ambiguous.count > 0`. Reading
  a per-observation boolean off `unattributedRefusals` is not the F12 double-count
  — that defect was adding magnitudes across slices — and a row two slices share
  correctly makes both observations hold-excluded, because both reports withheld.

Two frozen floors survived the partition intact, because the text words them over
"admitted": `unexercised` is "fewer than 5 **admitted** observations carrying its
rows", and a stratum is evaluable on "≥ 5 **admitted** observations each". Both
`deliveryScore` and `strataCells` therefore take an explicit population PAIR and
neither member defaults to the other — passing the hold-eligible set for both is
the obvious implementation and silently redefines a floor the design fixed.

### F22 — `voidConditions` 18's 30% half was a conjunct that could not fail — FIXED

Found while writing F19's hold branch, not reported by any reviewer.

The check `![rLoMinusTask, rLoMinusRow, rAll].some(v => v >= 0.3 !== rLo >= 0.3)`
was the last conjunct of the hold. The conjuncts above it had already required
`rLo >= 0.3` and all three recomputations `>= 0.3`, so every operand was on the
same side of the line by the time it was evaluated and the expression was always
`true`. **It sat directly beneath a comment explaining that the F9 guard had been
removed for exactly this reason** — a guard that cannot fail, three paragraphs
under the house rule against them.

Moved to the PUBLISHED recomputations against their own parents, and placed after
the fall branch. There it decides something: with the domains split, a published
figure can straddle 30% while the hold domain does not. Deleting it before that
fixture existed changed no test; deleting it after flips the verdict from `open`
to `holding (unvalidated)`, which is how the guard was established as a guard.

**THE FIRST FIX NARROWED THE CLAUSE WHILE FIXING IT, and the review caught that.**
Clause 18 names five recomputations — `R_lo⁻ᵗ`, `R_lo⁻ʳ`, `R_hi⁻ᵗ`, `R_hi⁻ʳ`,
`R_all` — and gives them two readings. The 15% void ran over all five; the new 30%
check ran over three. **No hold condition reads `R_hi` at all**, so a high-side
straddle is invisible to every conjunct of `decideHold` and only this check can
catch one — a run could return `holding (unvalidated)` with `R_hi⁻ᵗ` at 16.7%
against an `R_hi` of 35.1%. Both readings now share one `[name, value, parent]`
list built once, and the eighth control pins the high-side case with no ambiguous
observation anywhere in the fixture.

**TWO MORE CONJUNCTS THAT COULD NOT FIRE went with it**, both of them `holdsIf` 5,
one written in this pass and one carried over unexamined. `voidConditions` 16
voids on the exact complement of `excludedWouldHaveAdded <= admittedSumS`, so
reaching the hold proves it; and `rHiPlus` iterates admitted AND dropped and
refuses on any unsized owned refusal, so `excludedUnsized === 0` is proved by the
`open` above. Removed, with the ordering that subsumes them stated where they
stood. **The subsumption is exact for finite figures only** — a NaN would slip
both the void and the conjunct, and nothing defends against one beyond `oO`.
Three guards-that-cannot-fire in one file is a pattern, not an accident: the check
is now to ask of every new conjunct what run reaches it in a state where it is
false.

### F14 — `B12Result` could say two of the six verdicts the design defines — FIXED

`fallsIf` names `open — provisional` as a real state and `B12Result.verdict` had
no such member, so a provisional fall was published as a plain `open`. That was
the finding as recorded. **The adjudication found it was the smaller half.** The
verdict function returned `"fallen"` or `"open"` and nothing else: it checked no
observation count, no rate basis, no selection guard, no recomputation, no
register — six frozen VOID clauses it had the data for — and it collapsed
`holding (unvalidated)` into `open` as well.

**Fixed** with the ordered rule in `UNIT-3.md`: six voids, each naming its clause
on the artifact, then the two `open` states the frozen text settles, then the
fall, then the hold. `B12Result` gains `voidClause`, `selection`, `priorRuns`,
`voidedRuns` and `abandonedRuns`; `AggregateInput` gains a REQUIRED `priorRuns`,
because `voidConditions` 1 makes omitting the register itself a VOID and an
optional field would be indistinguishable from a first run.

**Two clauses of the frozen text contradict themselves, and both are settled by
quotation rather than by preference.**

- `voidConditions` 15 opens "VOID if any refused magnitude is null and R_hi+ was
  therefore not evaluable" and ends "the run returns `open`, never a fall", while
  `fallsIf` says `open — provisional`. `design.metric` settles it in words: "If
  any refused magnitude is `null`, `R_hi⁺` is NOT EVALUABLE and **the run returns
  `open`**." Two of the three name `open`, and it is the only reading that does
  not spend an irreplaceable attempt (`voidConditions` 23) on an ambiguity.
- `voidConditions` 3 does the same to an undersized stratum, and `admissionRule`
  8 settles it outright: it "returns `open`, never a hold, a fall, **or a void**."

**Two shapes carry a rule instead of checking it.** `PriorResult` makes a prior
run state `scored` or name its void clause, and carry its bracket either way, so
clause 1's three requirements cannot be satisfied separately. `AttemptCost` makes
"did not consume an attempt" unrepresentable without naming which of clause 23's
three enumerated vendor-side causes it was — "every other void is an attempt, or
the fall condition can be dodged indefinitely by voiding until a clean set lands
on the preferred side".

**And the F9 hold-side guard turned out to be subsumed rather than owed.** It was
registered during the F9 fix as owed to whoever wrote a hold branch. Written as a
conjunct of the hold it can never decide anything, because `rHiPlus` refuses on
that exact fact and the run has already returned `open`. Established by planting
the defect: deleting the conjunct changed no test. Removed and explained, on the
same rule that retired step 1b — a guard that cannot fail is not a guard.

### F10 — the window join was wider than the crediting join — FIXED

`windowInvocationIds` collected ids from **every** `transcript.toolResults` entry.
`byInvocation` (`report.ts:894-898`) is built from
`toolResults.filter(isLocalToolResult)` — gate and repair only.

Transcript ids are scanned out of arbitrary serialised output, so a result that
merely QUOTES an id put it into `mine` while `byInvocation` had never held it.
Two consequences, both small and both real: an `excludedForeign` row was
*practically* unownable rather than *provably* so (F1's corrected residue), and a
window could claim an id that is not this server's at all — the over-wide window
`terms.ts`'s own header warns about.

**Fixed** by exporting `isLocalToolResult` and applying it as the FIRST hop of the
join, which is now five and was documented as four. One predicate in one place:
the alternative is a second copy of the rule in the module that has to agree with
it. `mine ⊆ byInvocation.keys()` on every input afterwards, which is exactly what
makes `excludedForeign` provably unownable.

Seen failing: an owned request calls `Read`, whose result quotes an invocation id.
Without the filter the window claims two ids where it owns one.

**One overstatement corrected in the process.** This entry said a `Read` of
`.local-coder/telemetry.jsonl` would mark "every id in the project's whole
history" as this session's, and `report.ts` said the same. `readInvocationId`
runs a single non-global `exec` and returns the FIRST match
(`readInvocationId` in `transcript.ts`), so a quotation injects ONE id per
result. That is still
enough to misattribute a saving; it is not the whole history.

### F12 — `unattributedRefusals` double-counted, and the fix had to be run-level — FIXED

`scopeTelemetry` admits a row on an exact invocation-id match **or** on a
±60,000 ms window (`src/cost/report.ts`, `windowMs = 60_000`), and
`admissionRule` 5 names that window
by hand, so one physical row sits in two observations' slices whenever two arms
ran within a minute. `rHiPlus` summed each observation's `unattributedRefusals`,
so that row was counted twice.

**The direction follows the sign.** `d/dF [(S+F−O)/(A+S+F)] = (A+O)/(A+S+F)² ≥ 0`,
and `F` can be negative because `wouldHaveAdded` is signed — a row whose returned
bytes exceed its capped raw bytes has a negative magnitude, and this project has
measured whole tools net negative. Positive duplication moved `R_hi⁺` up, which
is safe; **negative duplication moved it down and manufactured a fall.**

**Fixed** by `src/cost/b12/coverage.ts` (UNIT 4): row identity is
`JSON.stringify([artifact, ordinal])`, stamped by `identify` at read time,
because `TelemetryRecord` carries nothing that survives a null `invocation_id`.
`ObservationTerms.rows` and the new `ObservationTerms.unattributed` are keyed;
`runCoverage(universe, all)` resolves every physical row once; `rHiPlus` reads
owned refusals per observation and unowned ones from the run ledger.

**Step 1b is retired with the sum it guarded.** It refused on a negative
unattributed class sum and this file declared it incomplete the day it landed —
a class sum of zero hides a +100 and a −100. A guard standing over a quantity
nothing computes any more reads as protection while providing none.
`unattributedRefusals` survives as a per-window diagnostic that no figure sums.

**Two corrections from the adjudication, both adopted:**

- **`runCoverage` cannot take `ObservationTerms[]` alone.** `computeTerms`
  receives a slice `scopeTelemetry` has already narrowed, so a row outside every
  window is absent from every observation and invisible to a coverage built from
  them. The run's full identified row set is an argument, and `unsliced` is the
  state for a row the run produced that no window saw.
- **"Exactly one distinct non-null value" was too weak.** One number beside one
  `null` counted as agreement and discarded the unknown. Every occurrence must be
  sized AND equal, or the row is `unsized`.

Two slices can also disagree about what a row IS — `credited` in one transcript
and `excludedForeign` in another (`report.ts:1081-1107`). `unverifiable` and
`ambiguous` cannot vary that way; the other three can. No frozen class means "the
transcripts disagree", so such a row is unsized and carries a `conflict` string.
It needs no refusal rule of its own: every reachable disagreement either contains
`credited`, which trips F9's condition, or contains `unmatched`, which is unsized
by construction.

### F9 — a credited row no window owns vanished from every `S_o` — FIXED

REACHABLE, with a concrete path, not a hypothetical:

1. A transcript holds a local `gate`/`repair` result whose payload carries no
   invocation id. Then `localResults.length > 0` and `byInvocation.size === 0`,
   so `provenanceUnavailable` is true (`report.ts:908`).
2. An id-bearing telemetry row is admitted through the timestamp fallback
   (`report.ts:1100-1107`).
3. With a later request present it becomes a **credited** row.
4. No local result carries that id, so it is in no observation's `mine`, and
   `computeTerms` dropped it before `S_o` and before every refusal class.

`computeTerms` structurally cannot detect this — it is handed one observation at
a time, which is why the fix is UNIT 4's and not UNIT 2's.

**Fixed by REPORTING AND REFUSING, not by crediting.** `design.metric` defines
`S_o` over "`o`'s credited rows" and limits `R_hi⁺`'s additions to the four
refusal classes, so adding such a row to the numerator would amend the ESTIMAND —
which B20's repair rule does not license, on the same reading that decided F11 and
F13. `coverage.unattributedCredited` publishes the count and the size, and
`rHiPlus` returns `open`.

**The refusal is unconditional, not sign-aware, and the first draft had that
wrong.** Omitting a credited magnitude `U` moves the figure by
`U(A+O) / (D(D+U))` with `D = A + S + refused`, so "a negative `U` is the safe
direction" needs `D > 0` and `D + U > 0` — and `rHiPlus` checks only
`denominator === 0`.

**And the hold side is NOT protected by omission, which is the other thing I had
backwards.** "Omission deflates the hold, which is the safe direction" is false
as written: magnitudes are signed, so an omitted NEGATIVE credited row RAISES
`R_lo` and `R_hi`, toward a hold. `verdictOf` has no hold branch today, so there
is nothing to guard yet; the requirement is written into `UNIT-3.md`'s verdict
rule and into `aggregate.ts` beside the function, for whoever writes it.

### F1 — two of the four refusal classes could never be populated — FIXED

`UNIT-2.md` step 6 kept only rows whose `invocationId` was non-null and in
`mine`; step 10 built the four-class ledger from those.

- **`unverifiable` is structurally unownable.** The class exists precisely
  because `entry.invocation_id === undefined` — the branch in
  `buildCounterfactual` that counts `unverifiable` — so `refusedRow` gives it
  `invocationId: null` and step 6 dropped every one.
- **`excludedForeign` is empty on every normal input, but not provably so.** The
  class exists because the id is absent from `byInvocation` — and `mine` is built
  from a *wider* set of tool results than `byInvocation` is, so the two are not
  exact complements. **Corrected from "structurally empty"** after the gate-1
  adjudication; the residue is **F10**.
- **The direction was overstated too.** `wouldHaveAdded` is signed — its `tokens`
  term is `min(bytes_raw, clientTruncationCap) − bytes_returned`, which goes
  negative — so omitting a refusal deflates `R_hi+` when its magnitude is
  positive — the ordinary case — and inflates it when negative. "Deflated by
  construction" was too strong; "deflated on any run whose refused magnitudes are
  positive" is what the code supports.

`rHiPlus` is defined over all four classes (`design.metric`), so the fall-side
figure was short by two of them.

**Fixed** by a second ledger, `ObservationTerms.unattributedRefusals`, holding
every refused row in the slice whose `invocationId` is null or not in `mine`.
`rHiPlus` summed both and refused on `unsized > 0` in either.

**Superseded 2026-08-07 by F12's fix, and this paragraph used to end here.** That
shape double-counted every row two slices share, so the second ledger is now a
per-window diagnostic nothing sums: the unowned rows are carried INDIVIDUALLY in
`ObservationTerms.unattributed`, deduplicated by row identity in `runCoverage`,
and `rHiPlus` reads the run-level result. The fix to F1 stands — the fall-side
figure was short by two classes and no longer is — but the route it took to get
there did not.

### F2a — `MIN_REPAIR_CLOSURES` was not implementable from the declared types — FIXED

`UNIT-3.md:87` passed the constant and nothing carried `passed`.

**Fixed** with `CreditedRow.passed: boolean | null` read from `entry.detail.passed`
only when it is a boolean, plus required `DeliveryTerms.closures` and
`closureUnknown`. **Absent is `null`, never `false`** — `repair`'s abort path
(`repair.ts:458`) writes a detail with no verdict, rows predating the field exist
on disk, and a string is not a verdict. The floor counts **observations** with
`closures > 0`, which is how `holdsIf` words it ("≥ 5 admitted observations carry
a `repair` row AND at least two of THOSE carry `passed: true`"), so several
closures inside one observation still contribute one.

An unknown deflates the count and pushes toward `unexercised`, which is neither a
hold nor a fall — the safe direction, now stated in the type rather than implied.

### F2b — `rLoMinusRow` dropped the row that dominates the OTHER figure — FIXED

`units` is `(capped / charsPerToken) * multiplier` (the `units` field of
`report.ts`'s credited row) — exactly
`sHi`'s contribution — and `UNIT-3.md` ranked both jackknives by it. `holdsIf` 2
asks a hold to survive deleting "**its** best row", per figure.

`aggregate.ts` could not compute the low side at all: `AggregateInput` carries no
`rates`, and a row exposed `capped`, `ttl`, `rateKey` and the realised **high**
multiplier but not the write component.

**Fixed** with `CreditedRow.unitsLo`, computed in `report.ts` beside `units` on
both the credited and the refused path, `null` exactly when `units` is `null`.
`wouldHaveAdded` returns both horizons for that reason: `unitsLo: null` on a row
whose `units` is a number would have given `null` a second meaning on a field
whose whole contract is that it means one thing.

**Accepted side effect, registered:** `UNIT-2.md` step 7 collapses to
`sLo += row.unitsLo` / `sHi += row.units`, which removes `multipliersFor` from
the unit — the import F6 was fixed for. One rule in one place is the discipline
`report.ts` states about itself. F6's lesson survives at half strength: `rateKey`
still comes from `../rates.js` at step 13.

### F3 — an unrecognised `verificationStratum` vanished with no trace — FIXED

`strata.ts:77-81` was `if` / `else if` with no `else`. **And the field is not
merely unvalidated — nothing writes it.** `scripts/b12-run.mjs` emits no
`verificationStratum` into `observation.json`, so it reaches the scorer through a
manifest join that has not been built, and three places in the repository claimed
it was "read off the observation".

**Fixed** with a sixth `unknownStratum` bucket, the comparison widened to
`const declared: string` so `tsc` allows the branch, and `strataCells` refusing
**both** declared cells while it is non-empty. Not a throw: `aggregate()` owes an
artifact "whether it scores or voids".

**Plus the amendment gate 1 raised, confirmed against `fallsIf`:** `"fallen"` now
additionally requires all four strata cells evaluable. The frozen text says it
twice — a fall stands unappealed only if "both subagent strata are evaluable",
and "any stratum below 5 is VOID or `open` — never a fall on a short set".
Without it the F3 fix would have produced unevaluable cells that nothing read.

`unknownStratum` is deliberately **not** treated like `unevaluableShare`: a
window that originated no billed request belongs to neither `solo` nor `multi`
and deflates neither, while an observation with a corrupt stratum belongs to one
of the two declared cells and nobody can say which.

### F16 — no file under `tests/` was type-checked by anything — FIXED

`tsconfig.json` is `"include": ["src/**/*.ts"]`, and vitest transpiles without
checking. So every oracle, every fixture and every helper in this repository is
**unchecked TypeScript**: a fixture that stops matching its type, an assertion
against a field that no longer exists, a factory missing a newly required
property — none of it is caught until an assertion happens to read the value, and
often not then.

The repository already knew and wrote it down twice — `src/contract-probe.ts`'s
header and `src/cost/b12/types.ts`'s — as the reason those files live in `src/`.
It was not carried into the test tree's own claims: several comments added by the
scorer-correctness pass said an oracle's "API shape is pinned by `tsc`", which is
false. Corrected.

**Measured before proposing anything:** compiling `src/**` and `tests/**` under
the existing `strict` settings produces **14 errors across 3 files** —
`repair.test.ts` (12, all union access without narrowing: `ToolError |
RepairResult` and `RepairDeps | undefined`), `helpers.ts` (1, a missing DOM lib
name), `cost-meter.test.ts` (1, no declarations for `scripts/b12-run.mjs`). None
is a real type mismatch, and **none is in the b12 oracles or fixtures**.

**Fixed by swapping which config is which, rather than by adding a third.**
`tsconfig.json` is now the CHECKING config — `src/**` plus `tests/**`,
`noEmit` — and emitting moved to `tsconfig.build.json`, whose `include` stays
narrow so `dist/` and the published package never carry the tests. That was the
only shape that needed no change to `gate`: its autodetection hardcodes
`tsc -p tsconfig.json --noEmit` (`src/checks/config.ts:165`), and so does
`scripts/b12-preflight-mac.sh`, and so does every editor. A `tsconfig.tests.json`
that nothing invoked would have been the same hole with a config file in front
of it.

The 14: `NonNullable<Parameters<typeof runRepair>[2]>` for five `fetchImpl`
casts; a `rejectionOf` helper narrowing `RepairResult | ToolError` at three sites
that were reading `.message` off the union and would have read `undefined` the
day the call stopped rejecting; `Parameters<FetchLike>[0]` for a `RequestInfo`
that is a DOM name under `lib: ["ES2022"]`; and `scripts/b12-run.d.mts` for the
one harness function a test calls.

Seen failing: `billedRequestCount: "one"` in `tests/b12-fixtures.ts` now gives
`TS2322` from the gate. **`scripts/**` is still unchecked** — deliberately, and
`contract-probe.ts` and `contract-stability.ts` say so in their headers, which
were corrected here along with six other comments that named the old scope.

### F15 — `CreditedRow`'s null invariant was not encoded, so `?? 0` passed everything — FIXED

`units` and `unitsLo` were `number | null` on a flat interface, so
`disposition === "credited"` narrowed neither and `row.unitsLo ?? 0` compiled,
passed every oracle in the repository, and committed the exact
unknown-summed-as-zero collapse this scorer forbids everywhere else. The
invariant lived in a doc comment, and a doc comment cannot stop an implementer.

**Fixed** by making `CreditedRow` a union discriminated on `disposition`:
`CreditedLedgerRow` has `units`, `unitsLo` and every positional field as
non-null; `RefusedLedgerRow` keeps them nullable and `units`/`unitsLo` null
together. `UNIT-2.md` step 7 now says to narrow on the disposition instead of
prescribing a throw — the compiler does the work the throw was standing in for.
The positional fields came along for free: "null on a refusal" is now a type
rather than a paragraph.

**The control is two `Assert` type aliases beside the union, in `src/`** — where
it had to be when the union landed, because `tests/` was read by no compiler
then (**F16**, fixed since). It stays beside the type it constrains rather than
in a file that imports it. Seen failing: widening `CreditedLedgerRow["units"]` gives
`TS2344: Type 'false' does not satisfy the constraint 'true'`. A runtime half
sits in `cost-meter.test.ts`, summing a real `buildCounterfactual`'s credited
rows at both horizons with no coalescing anywhere.

### F8 — the unit headers were swapped — FIXED

`strata.ts` said "UNIT 2" and is UNIT 1; `terms.ts` said "UNIT 1" and is UNIT 2.
Recorded here as one file; it was two. `aggregate.ts` was correct.

### F6 — `UNIT-2.md`'s only worked example taught the wrong module — FIXED

`UNIT-2.md` named six functions living outside the unit and gave the module for
exactly one — `positionalMultiplier` "from `../report.js`" — which is right for
three of them and wrong for `multipliersFor` and `rateKey`, both in `../rates.js`
and imported-not-re-exported by `report.ts`. The spec was not silent; it taught
an answer correct in the only case it demonstrated.

Not hypothetical: exposure B's `terms` call 2 imported `multipliersFor` from
`../report.js`, took `TS2459`, and round 3 timed out. Call 1 dodged it by using
`rates.multipliers` directly and reimplementing `rateKey` inline — two
workarounds for one spec defect, in one exposure.

**Fixed** with an explicit import block plus the module at each call site. F2b
later removed `multipliersFor` from the unit entirely; `rateKey` remains.

### F7 — `budget_seconds` was an unregistered parameter truncating a registered one — FIXED

`repair`'s default budget is 300 s. `aggregate`'s rounds cost 106–132 s because
it writes ~3,400 completion tokens against `terms`' ~1,700, so the registered
`max_rounds: 3` was delivered as **two** productive rounds for that unit, at any
window. Three units of one exposure were measured against different effective
conditions.

Raising the budget alone would have traded a truncation for a starvation: the
per-request timeout is `min(config.timeoutMs, remaining)` (`shared.ts:547`), so
at 600/600 one slow round can be issued with the whole budget. The longest
LEGITIMATE round observed is **132 s** — corrected from 149 s, which carries
`attempts: 0` and "LM Studio request timed out after 148755 ms"; the 256 s round
was the backend returning HTTP 400.

**Fixed** as `TIMEOUT_MS=180000` / `BUDGET_SECONDS=600` / `MAX_ROUNDS=3`, and —
because both travel through a prompt as optional arguments with defaults —
recorded in `detail.budget_seconds` / `detail.max_rounds` as **resolved** values
and checked per repair row. A session that drops one is a `limits-mismatch` VOID;
a row predating the fields is `limits-unverifiable`, never a pass.

Do not re-run a unit that already has an observation to give it the rounds it
should have had — that is a second draw at the same bar.

### F4 — a unit's state came from the vitest exit code alone — FIXED `f6926b4`

`repair`'s own `passed` was never read, so "the model ran and failed" and "the
model never ran" were the same `red`. Worse, the scorer commits the bodies it
produces while the fresh-exposure guard only refused on **uncommitted** ones, so
a later run on a clean tree could inherit all three through `already-green` and
print `R_repair reachable (>= 2 of 3)` with zero `repair` calls.

Now a per-unit telemetry window and a closed list of six states, of which only
`closed` counts; the guard compares each attempted unit against its stub at a
pinned commit. Exercised by `scripts/b12-scorer-selftest.sh`, which extracts both
decision points verbatim and replays exposure B's real slice.

### F5 — the exposure's central VOID was a check that could not fail — FIXED `ee7defb`

Exposure B pre-registered "VOID if `report.ts` was not actually in the context —
checked against the telemetry's own `detail.files`/`context_files`".
`detail.context_files` did not exist, and `detail.files` is the diff's changed
list — editable files only, structurally incapable of holding a read-only context
file.

Now reported on a `ToolDeps` callback off the **loaded** files, never off the
argument, and verified per repair row by the scorer. First observed rather than
declared in `run 2026-08-07-mac-b12-phase3-c40e9f4`.

---

## Review status of the authored bodies

| unit | authored by | reviewed | verdict |
|---|---|---|---|
| `strata.ts` | local model, `c40e9f4` | 2026-08-07 | **accepted**; correct against `UNIT-1.md` step for step. F3 fixed here by hand. |
| `terms.ts` | orchestrator, 2026-08-07 | — | implemented after Phase 3 closed |
| `aggregate.ts` | orchestrator, 2026-08-07 | — | implemented after Phase 3 closed |
| `coverage.ts` | orchestrator, 2026-08-07 | — | UNIT 4, written for F12/F9, never part of the exposure |

`terms.ts` and `aggregate.ts` stopped being measured work when Phase 3 closed at
1 of 3. `repair` never closed either of them and gets no further draw.

`strata.ts`'s two bodies are 34 lines; every comment, both interfaces and the
imports were already in the stub. `UNIT-1.md`'s steps 1–7 are close to executable
pseudocode, which is worth remembering when reading the one unit that closed.

**Any hand-edit to an authored body goes in a commit of its own**, separate from
the run's. `git log -p` is the only thing that keeps "what the local model wrote"
legible once a human has touched the file.

## Nine assertions, now proved as controls

The scorer-correctness pass added seven assertions to
`tests/b12-aggregate.test.ts` and two to `tests/b12-terms.test.ts`. They were
written against stubs, so every one of them failed on `not implemented` whether
it was right or wrong, and each carried an `UNPROVED CONTROL` marking saying so.

**Re-checked 2026-08-07, the day the bodies landed**, in three groups of three
defects planted in three different functions so attribution stayed clean. All
nine fired, each for its own reason and no other:

| assertion | defect planted | what fired |
|---|---|---|
| both ledgers in `R_hi+` | sum only `refusals` | 110/1110 against 160/1160 |
| unsized in EITHER ledger | check only `refusals` | evaluable, should refuse |
| negative unattributed magnitude | drop the guard | evaluable, should refuse |
| per-horizon row jackknife | rank the low side by `units` | 70/270 against 60/260 |
| both cells on a corrupt stratum | drop the rule | cells stayed evaluable |
| closures per OBSERVATION | count closure rows | scored, should be `unexercised` |
| `identityHolds` false on `O ≠ 0` | compare against `S` | true, should be false |
| the second ledger in `computeTerms` | file everything as owned | unattributed count 0 |
| `closureUnknown` on `null` only | treat `!== true` as unknown | counted a red repair |

**Three of them were defective when written, which is the argument for the
re-check rather than against it.** `strataCells`'s `typesOnly` arm was satisfied
by the 5-observation floor with an empty cell, so it passed on the defect it was
aimed at. The closure floor gave every fixture `closures` of 0 or 1, where
summing rows and counting observations agree. The closure test supplied only
`true` and `null`, so `passed !== true` satisfied both arms while merging a
repair that ran and failed with one that could not say. All three were fixed
before the bodies existed; **three defects in seven assertions is the rate to
expect from assertions nobody has watched fail.**

**A fourth defect surfaced on first execution, in the FIXTURE rather than in an
assertion.** `withToolUse` overrode `message` wholesale and dropped the
`cache_creation` split, so the transcript parser priced that request's write at
the 5-minute TTL — its documented conservative guess — while `req`'s own comment
promises 1h at 2.0x. Every constant hand-derived from that promise was 75 units
out on a 100-token write, and `A_o` came back 5725 against 5800. A fixture that
contradicts its own stated intent is invisible until something executes it.

## Twenty-two more, for F12 and F9

The F12/F9 pass added twenty-two assertions across `b12-coverage.test.ts` (new),
`b12-aggregate.test.ts`, `b12-terms.test.ts` and `cost-meter.test.ts`. **All
twenty-two passed on first execution, which is the state that says nothing.**
Each was then checked against a planted defect, in six groups of at most one
defect per function so attribution stayed clean:

| defect planted | in | what fired |
|---|---|---|
| drop the `unmatched` row push | `buildCounterfactual` | rows 4 for 5 telemetry entries |
| key as `${source}#${ordinal}` | `identify` | the encoding test, and the key on a priced row |
| never push to `unattributed` | `computeTerms` | the unowned rows came back empty |
| pair every row with `telemetry[0]` | `computeTerms` | two rows keyed ordinal 0 |
| sum only the owned refusals | `rHiPlus` | 110/1110 against 160/1160, and 200/2200 |
| one `CoveredRow` per occurrence | `runCoverage` | −600/1400 against −200/1800 |
| report a generic reason | `rHiPlus` | the artifact stopped carrying the cause |
| assign a contested key to its first claimant | `runCoverage` | contested came back empty |
| filter the nulls before the sizing check | `resolve` | 400 where the answer is unknown |
| drop the price-spread check | `resolve` | 400 chosen out of 400 and 900 |
| drop the disposition-disagreement check | `resolve` | 400 on a row nobody can class |
| drop the F9 reason | `runCoverage` | a credited orphan scored |
| drop the `unsliced` reason | `runCoverage` | a row nobody saw scored |
| drop the unsized-unowned reasons | `runCoverage` | an unknown summed as zero |
| take ownership out of the claims map | `runCoverage` | an owned row entered the run ledger |
| remove the sort in `resolve` | `resolve` | two callers, two different ledgers |

**Two fired on numbers written into the comments before any body existed** —
`110/1110` for the owned-only sum and `−600/1400` for the twice-counted row —
which is the only form of prediction this file counts.

**One assertion of the twenty-two could not be proved by its own defect and is
marked as such:** `rows[0].key` on a priced row fired under the ENCODING defect
but not under "always pair with index 0", because index 0's key is correct for
row 0 either way. The index rule is proved by the `unattributed` assertion beside
it, which fired on exactly that defect.

## Seventeen more, for the capture — and one type-level control

`src/cost/b12/capture.ts` and `tests/b12-capture.test.ts`, the first half of F24.
**All seventeen passed on first execution, which is the state that says nothing.**
Sixteen defects were then planted in five groups, restoring the file between each,
with the grouping chosen so that no ASSERTION is touched by two defects — which
is what attribution actually needs, and is weaker than one-defect-per-function:

| defect planted | in | what fired |
|---|---|---|
| iterate `Object.keys(source)` instead of `METERED_KEYS` | `reduceRecord` | `cwd`/`version`/`gitBranch`/`userType` archived |
| `message` left whole | `reduceRecord` | `id` and `stop_reason` survived the narrowing |
| `toolUseResult` replaced by its serialized LENGTH | `reduceRecord` | **563** where the payload belongs |
| drop the `key in source` guard | `reduceRecord` | absent keys came back as explicit `undefined` |
| `{}` for a non-object instead of `null` | `reduceRecord` | a malformed line archived as an admitted record |
| a non-object line not counted | `reduceFile` | 1 dropped where 2 were |
| no union-find — seed `sessionId` only | `lineageIndices` | the continuation left the lineage |
| only the FIRST matching component | `lineageIndices` | one file where the seed names two |
| a seed that matches nothing returns EVERY index | `lineageIndices` | the whole machine as one lineage |
| `.git` not skipped | `captureObservation` | `.git/objects/…` hashed as a source file |
| telemetry read from `process.cwd()` | `captureObservation` | **111 rows** — the repository's own live log |
| `dirtyAtCapture` hardcoded false | `captureObservation` | a dirty acceptance read as clean |
| the declared scope not labelled | `captureObservation` | `null` where the manifest declared one |
| native path separators kept | `captureObservation` | `src\a.ts` — unreadable off Windows |
| only the first slug searched | `captureObservation` | a fork into a second slug left the lineage |
| **`isLocalToolResult` filter removed** | `captureObservation` | **two invocation ids where the join owns one** |

**The last row needed a FIXTURE change before it could fire, and that is the
entry worth keeping.** With only a `gate` result in the transcript, deleting the
F10 filter changes nothing and the assertion passes on the defect it exists to
catch. It fires only once the fixture also carries a `Read` whose output QUOTES
somebody else's invocation id — which is F10's own scenario, and the reason the
filter is the first hop of a five-hop join rather than a tidiness.

**Two fixture defects surfaced before any control did**, both invisible until
something executed them: the assistant record carried no `tool_use` block, so the
result had `name: null` and failed the join; and the invocation id was `inv-1`,
while `readInvocationId` requires a UUID shape. Neither was a code defect. Both
are the same lesson this file already records — a fixture that contradicts its
own stated intent passes silently.

**A nineteenth, added after gate 2, and it is the identity contract itself.**
Nothing checked that the `telemetry.jsonl` the harness WRITES rereads as the
array UNIT 5 keys ordinals into — only that the captured value was right. The
control writes the file exactly as `observe()` does, rereads it with
`readTelemetry`, and asserts both equality AND order, over rows deliberately out
of time order. **Proved by a writer that sorts by `ts`** — which round-trips
perfectly as a SET and shifts every ordinal after the first, so the deep-equal
half stayed green and only the order assertion fired. That is the whole reason
the fixture's rows are unsorted.

**Four more for `design.artifacts` 5's per-file sha256**, in `cost-meter.test.ts`
against the existing snapshot fixture, and they had to be rewritten before three
of them could be proved. Written as four ordinary `expect`s in a row, the first
failure ends the test and the three below it never execute — so the
omitted-subagent-file defect fired the length assertion and left the hash and
sort assertions unproved WHILE LOOKING CHECKED, which is this file's oldest
failure mode wearing a new shape. They are `expect.soft` now, so all four
evaluate and each carries its own message. Proved by: hashing the file NAME
instead of its bytes, omitting the subagent file from the list while still
counting it, and sorting DESCENDING.

**The sort defect had to be planted twice, and the first attempt is the useful
one.** `.reverse()` did not fire: the directory walk returns
`sess-1/subagents/agent-a.jsonl` before `sess-1.jsonl`, and reversing that pair
happens to PRODUCE the sorted order, because `.` sorts before the separator.
A defect that accidentally implements the correct behaviour proves nothing, and
the assertion looked unprovable until the defect was replaced with a descending
comparator.

**WHAT IS NOT COVERED, STATED RATHER THAN LEFT TO BE ASSUMED.** The archive's
VALUE has nineteen controls; the harness WIRING has none. `observe()` needs a
real `claude` binary, a manifest that does not exist yet, and a live MCP server,
so nothing exercises the capture call, the `.mcp.json` refusal, the run-log row
or the commit barrier. **The commit barrier is the one that matters** — it is the
guard that makes "committed at each task's END" a fact, and a guard nobody has
watched fire is not a guard. It self-checks twice (the index is non-empty before
the commit, `HEAD` carries the path after it), which is defence written in the
absence of a test rather than a substitute for one. It goes on the list for the
day the manifest is sealed.

**The eighteenth control is a TYPE, and it names what is missing.**
`METERED_KEYS` is held to `keyof MeteredRecord` by an `Exclude`-based assert,
because `RawRecord`'s fields are all optional and adding one would NOT break an
object literal that omits it — the archive would quietly start dropping a field
the meter reads while every oracle stayed green, since no fixture carries a field
that does not exist yet. Seen failing: removing `"isCompactSummary"` gives
`TS2322: Type 'true' is not assignable to type '"isCompactSummary"'` — the
missing key BY NAME, not merely a red build.

## Ten more, for F19, F20, F21 and F22

The F19 pass added eight assertions to `b12-aggregate.test.ts` and the F20/F21
pass two more — ten in one describe block, of which **nine are controls and one is
a label** that pins a literal and is recorded as pinning nothing else. **All ten
passed on first execution, and every existing b12 test passed unchanged** — which
is the expected result and the reason none of it was evidence: the two domains are
the same set on every fixture written before this pass, so a partition that does
nothing looks exactly like a partition that works.

Six defects were planted, one at a time, restoring the file between each so no two
could cancel:

| defect planted | what fired | what did NOT |
|---|---|---|
| no partition at all — the pre-F19 body | 5 of the 8 | the clean-run identity test, correctly |
| `ambiguousCount` reads the OWNED ledger only — F19's own proposal | the unowned-ambiguous control, alone | the other six |
| Reading L: clause-6 exclusions kept out of `hold.rAll` | 2, with `R_all` at 30.56% against the correct 29.48% | — |
| delivery populations collapsed onto hold-eligible | the exercise-floor control, alone | — |
| strata floor collapsed onto hold-eligible | the cell-evaluability control, alone | — |
| `strata: hold.strata` on the published face | the face control, alone | — |
| the 30% reading narrowed to the three LOW recomputations | the high-side control, alone | — |
| `priced` counted off the FLOOR population | the two cell-count controls | — |
| one shared object for both corrupted cells | the unevaluable-cell control, alone | — |
| `priced` off the floor population in the CORRUPTED branch ONLY | the corrupted-branch control | the published-face fixture, where the two populations coincide |
| `counted` off the RATIO population | both cell-count controls | — |

**The second row is the one worth keeping.** F19 proposed that predicate itself,
and the control written to separate the two readings fires on it and on nothing
else — so the correction is pinned rather than asserted.

**The last row is the hazard a type could not have caught.** Both domains are in
scope exactly once, in `aggregate`'s final assembly, and `StrataCells` is
`StrataCells`; the slip is one word and no compiler objects. Branding the type was
considered and declined — `decideHold` cannot see the published figures at all, so
the brand would protect only that one line, and a control that exercises the real
assembly is better evidence than a label attached to the object.

**F22's guard was proved twice, in opposite directions.** Deleting it before the
straddle fixture existed changed no test — which is what established that the
conjunct it replaced could not fire. Deleting it after flips that run from `open`
to `holding (unvalidated)`.
