#!/usr/bin/env bash
# A/B Tetris no Mac: Opus só vs Opus + local-coder.
# Um comando, depois do clone/pull:
#   bash scripts/tetris-ab-mac.sh
#
# Antes dos dois braços, lista os modelos do LM Studio e pede qual usar.
# No fim imprime a tabela USD / output / cache_read / turnos / wall / entrega.
#
# Variáveis úteis:
#   TETRIS_AB_MODEL=...     pula o menu
#   TETRIS_AB_YES=1         não pede confirmação
#   CLAUDE_BIN=...          binário do Claude Code
#   TETRIS_AB_PARENT=...    onde criar os worktrees (default: pasta-pai do clone)

set -u
set -o pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
export PATH="${HOME}/.lmstudio/bin:${PATH}"

if ! command -v node >/dev/null 2>&1; then
  echo "node não está no PATH. Instale Node ≥ 18 e rode de novo." >&2
  exit 1
fi

cd "$ROOT" || exit 1
exec node "$ROOT/scripts/tetris-ab-mac.mjs" "$@"
