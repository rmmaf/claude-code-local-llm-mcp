# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**THE PLAN'S THREE PASSES SHIPPED AND SURVIVED R8** on
`claude/b12-f23-audit-register`: F23's uncapped bracket; the clause-6
controls, emission wrapper and audit computer; pilot, register (CAS,
create-only seal, cardinalities 30/5/6), admissionRule 7's grammar, the
observe registration guard, sessionId nonce+lock, snapshot identity stamps;
policy blobs as GIT PROVENANCE with the DUAL calibration key (the 2026-08-08
singular probe refused by name); the hardened Mac probes (+ NEW
`b12-truncationcap-probe-mac.sh`); `b12-author.mjs` with five named checks;
the R7#12 share formula registered. Details: FINDINGS.md, this file's log.

## Next action

R8–R29 (post-implementation adversarial rounds) are ADJUDICATED — thirty-nine
findings, all confirmed, fixed with firing controls (FINDINGS.md carries them
round by round): the CAS act's capture, the fail-closed probes, clause 6's
holes, the snapshot stamps, the attestation worktree, and — six rounds on one
surface — the post-registration sync, from disk bytes to an APPEND to an
index installed under git's own mutex. **R16 was the worst: the real index
stayed on `expectedHead`, so the operator's next ordinary commit UNDID the
registration (reproduced).** **R18: the register's append is now RE-READ, and
the runlog row + its evidence commit became ONE act under a run-wide lock —
OVERTURNING R11's declination, whose premise (the barrier serializes) is
false, since both processes pass it before either appends.** **R19: that
mutex is an INDEX lock — the ref is now read by NAME AND TARGET under it, the
writes moved INSIDE it, and the residual it cannot cover is written down.**
**R20 leaves concurrency entirely: the act took the run's IDENTITY from the
CLI argument and never asked the manifest, so a typo would register a row no
session can use and no result can close.** **R21: `src/cost./**` OPENS
`src/cost` on Windows and compared unequal to it — trailing dots/spaces,
colons and the 8.3 `NAME~1` shape are now REFUSED by admissionRule 7's
grammar in both copies (case stays FOLDED: that spelling is lawful, these are
not); and the create-only seal became create-only by its WRITE (`wx`).**
**R22: a manifest ALREADY in history can never satisfy "the same command", so
the act now asks before minting the irreversible row; and a committed clean
audit no longer counts forever — ANCESTOR of HEAD, diff confined to
`evidence/**`, evidence-borne inputs RE-HASHED. That control found a third:
the artifact recorded the prereg CONSTANTS, not the path it read.** **R23:
`open-b` is a registration and skipped the act's preconditions; a clause-6
control was identified by TITLE alone — now (file, fullName), exactly one.**
**R24 falsified R22's own completeness claim: naming four evidence files is
not covering `evidence/**`, so the runlog + counterfactual + every
observation archive now ride in ONE recorded digest the emission recomputes;
and the attestation stopped borrowing the enclosing repo's node_modules —
`npm ci` from the SUBJECT commit's lockfile, whose sha it records.**
**R26 is the worst of the loop: the verdict was the ARTIFACT'S, not the
audit's — any committed JSON with one input and `verdict: clean` published
clauses 4–6 as CHECKED. The parse now demands the WHOLE key set and the
emission RE-DERIVES the judgement, every input equal except `head` (the one
R22 named). And the evidence commit went wherever HEAD pointed: a checkout
mid-observation put a paid observation on another branch with the act
reporting success — the branch is now captured at the barrier and every
verification reads IT, not HEAD. **R27: that check was TOCTOU and the damage
irreversible, so the install became a CAS — temp index from the captured tip,
`commit-tree`, `update-ref <ref> <new> <expectedTip>`. No checkout, no index
install: the tree is the tip's plus these paths, staged first, so the R14–R19
saga does not repeat. Side effect worth knowing: plumbing runs NO hooks, so
R25's pre-commit threat is closed by construction and two of its controls now
assert that. R28: that CAS built its temp index at `<root>/.git`, a FILE in a
linked worktree — every observation here would have failed AFTER the append.
`--absolute-git-dir`, resolved BEFORE the append; the register had discarded
that assumption rounds ago. R29, both in the auditor and both the same shape
— a fact ASSERTED and never checked: a STALE counterfactual (an early emit,
then more observations) made a scored run read anchorless, so clause 5 went
FREE and pinned-path drift audited CLEAN (reproduced); and the attestation's
lockfile sha was validated as 64 hex and never compared to
`<subjectCommit>:package-lock.json`.**
**R25 reviewed R18's own fix: "the row and its evidence as ONE act" verified
only the EVIDENCE — a pre-commit hook (the threat model already written down
for the archive) could drop the runlog row and the act still returned ok. The
row is now held to the same blob standard: disk == barrier bytes + this one
row, HEAD == disk.**

**R23's residual is DECIDED (2026-08-10), and the frame was wrong here:
cláusula 6 ALREADY forbids a gutted control ("shown FIRING"); what was
missing was the PROOF, since the audit checks present-and-passing. So
byte-pinning is an amendment — and it is a FENCE, not a proof: an edit may
STRENGTHEN a control, unchanged bytes may stop proving anything. Both halves
shipped: the conformance hashes at registration and at subjectCommit, REPORTED
and deciding nothing; and a pre-data amendment, COMMITTED ALONE, widening
clause 5 only when its own introducing commit precedes the freeze anchor. The
window closed is the only outcome-aware one: after the first score, before
the attestation. STILL OPEN, written down: gutting BEFORE the first score
(no clock reaches it) and mechanical proof of firing (a mutation harness).**
PR to main is open — merge is the user's act.

## Still blocking a run

The A/B pass (scorer + VOID 21 and VOID 12 adjudications — **NO A/B before
both are registered**); the 65-sibling corpus (b12-author compresses it);
the Mac trips: policy-bundle transport, dual-key re-probe, cap probe, formal
preflight, pilot; the platform amendment (pre-data, after the exploratory
cert, before the formal preflight); the Phase-3 1/3 amendment (gate-only is
CUT; only a NEW pre-data amendment seals); contract-stability re-run (F23
grew report.ts); then seal-harness → register (CAS) → the 20–26 supervised
sessions → the clause-6 sequence → verdict → A/B.

## Do not redo

- The O-bracket is DECLINED and so are its cousins: no control-arm
  `installedChars`, no minted VOID-21 hash, no minted verdict-precedence RULE.
- Never back-fill an append-only record; three phase-3 run ids stay row-less.
- `tests/fixtures/b12-run/` is TEST MATERIAL, never evidence.
