# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**THE PRE-FLIGHT PASSED ON THE MAC** at `2eab63d`, 11 checks green — the first
time the whole chain ran end to end. `provenanceUnavailable false`, `ambiguous
0`, `unmatched 0`, `excludedForeign 0`, and both tools produced a row that did
work. **`repair` has now been called for real, once** — that number was zero for
the project's whole history. Snapshot there covers 16 slugs / 52 files / 1740
ids, a fraction of this machine's. Read from the pasted terminal only: the
artifact `evidence/2026-08-06-mac-b12-2eab63d.preflight.json` has NOT been read,
so nothing is registered in MEASUREMENTS.jsonl from this run yet.

## Next action

**Read the artifact, then seal the manifest and take the first scored
observation.** `savedFraction 0.2851` from that run is an INSTRUMENT reading on
a one-line synthetic fixture — not a B12 result, and registering it as one is
the exact failure this registry exists to prevent. **Yours:** the version pin,
now answerable — the Mac is 2.1.221 throughout, so B12's one-version VOID
condition holds if the whole run stays there; G-stop naming the cost meter a
delivery that cannot be scored; G7's threshold; B14 3.978 vs 3.5.

## Do not redo

- **The project already had the rule.** My second model-id comparison refused a
  Mac where the model WAS loaded; `matchModel` in `src/selection.ts` resolves it.
- **Test the good values, not one bad one.** `[ "$X" = "none" ]` passed when the
  probe failed and X was `""`, and printed `ok` for an empty answer.
- **A signal handler that returns does not stop the script.** Ctrl-C ran the
  cleanup and continued, and could leave `passed: true` at the deliverable path.
