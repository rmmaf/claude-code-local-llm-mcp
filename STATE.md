# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 40 lines below this header.

## Where I stopped

**Phase-3 exposure A read 1 of 3 — INCONCLUSIVE. Exposure B is pre-registered.**

- **`run 2026-08-06-mac-b12-phase3-d746d07`, US$ 0.74 of 40.** The one closed unit
  is `strata`, **inherited**; this run closed nothing. Manifest not sealable.
- **`repair` never produced a state better than the untouched stub** — 4 calls,
  11 rounds. `terms` 4→9→9 and 4→7→7→7; `aggregate` 10→28→28 and 10→25→23→23.
  `best` starts at the ORIGINAL bytes, nothing displaced it, so the empty `diff`
  is the measurement. **This corrects attempt 1's "the harness lost the diff"**:
  it kept it, there was nothing to keep.
- **Round 1 worse in 4 of 4**; one improvement in seven later rounds. Replicates
  `mac-09` (12 of 12 net negative against a TypeScript gate) on a new corpus.
  Completions held at 1895/1898/1898 — re-emitting, not correcting.
  `envelope: no_blocks` **6 of 13**, all `finish_reason: stop`. Still unexplained.
- **The window was never the constraint**: largest prompt 14,231 of 32,768.
- **Checked and rejected: the harness did NOT hand it an impossible task.** The four
  `RowDisposition` literals are `RefusalLedger`'s own fields in `types.ts`; it took
  `void(...)` from `Disposition` in the same file and merged them. **Result, not void.**
- **Two IOGPUFamily panics** killed earlier runs — not memory, not power. 26.6.1 held.

## Next action

**Reset all three bodies, then run exposure B on the Mac:**
`git checkout -- src/cost/b12/ && bash scripts/b12-scorer-mac.sh`

Load at **65536** first (`lms load … --context-length 65536 --ttl 3600`): the floor
doubled because `src/cost/report.ts` (51,747 B ≈ 14,800 tokens) joins `context_files`,
and at 32768 that puts aggregate's retry inside the margin where
`context_would_overflow` is reported as `model_failed`. Both changes pre-registered
together, **including that a better result cannot attribute**. Prediction: 1 of 3.

## Do not redo

- **A control never seen failing is not a control**, and two of mine could not.
- **Four refusals this week stated the symptom and destroyed the cure** —
  `a3e9a8f`, `a07d4ab`, `d746d07`, and `b91f236`, where the message I had just
  written crashed on an unset variable because I never ran it. `bash -n` parses;
  it does not expand. Exercise every refusal path, do not read it.
