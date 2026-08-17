#!/bin/sh
# b12-pilot-bootstrap-mac.sh — the weekday ONE-COMMAND entry to the pilot round.
#
#   curl -fsSL https://raw.githubusercontent.com/rmmaf/claude-code-local-llm-mcp/<PIN>/scripts/b12-pilot-bootstrap-mac.sh | bash -s -- <PIN>
#
# The URL names the PIN COMMIT, so the bytes running here are the bytes that
# commit sealed — the same self-reference the cut script's .b12-round-pin
# provides in archive mode. Everything is inside main(), called on the last
# line: a truncated download parses to a function nobody calls and executes
# NOTHING (the pipe-to-shell failure mode).
#
# What it does: move any prior ~/b12-tree aside (never delete), clone the
# branch with the eol flags that govern the checkout, and exec phase P1 with
# B12_EXPECT_SHA=<PIN>. P1 then verifies HEAD against the pin, persists it to
# .b12-round-pin for P2 and Q, writes the eol settings into the clone's local
# config, and runs the whole gate — nothing here is trusted downstream.
main() {
  set -u
  PIN="${1:-}"
  BRANCH="${2:-claude/b12-pilot-phase2}"
  case "$PIN" in
    ????????????????????????????????????????) : ;;
    *)
      printf 'REFUSED — pass the full 40-hex pin: ... | bash -s -- <pin> [branch] (got "%s").\n' "$PIN"
      printf 'The pin is in the runbook message that handed you this command.\n'
      exit 2
      ;;
  esac
  DEST="$HOME/b12-tree"
  if [ -e "$DEST" ]; then
    PREV="$DEST-prev-$(date -u +%Y%m%d-%H%M%S)"
    [ -e "$PREV" ] && PREV="$PREV-$$"
    mv "$DEST" "$PREV" || {
      printf 'REFUSED — %s exists and cannot be moved aside. Move it by hand, then re-run.\n' "$DEST"
      exit 2
    }
    printf '   ! prior tree moved to %s (nothing deleted)\n' "$PREV"
  fi
  git clone -c core.autocrlf=false -c core.eol=lf --branch "$BRANCH" \
    https://github.com/rmmaf/claude-code-local-llm-mcp.git "$DEST" || {
    printf 'REFUSED — git clone of branch %s failed. Check the network and the branch name, then re-run.\n' "$BRANCH"
    exit 2
  }
  [ -f "$DEST/scripts/b12-pilot-p1-mac.sh" ] || {
    printf 'REFUSED — the clone carries no scripts/b12-pilot-p1-mac.sh. Wrong branch? Got %s.\n' "$BRANCH"
    exit 2
  }
  B12_EXPECT_SHA="$PIN" exec bash "$DEST/scripts/b12-pilot-p1-mac.sh" "$DEST"
}
main "$@"
