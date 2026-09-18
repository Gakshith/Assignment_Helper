#!/usr/bin/env bash
# Integration check. Run after EVERY strand merge, never once at the end.
#
# Plan §C.3: "Integration is a budgeted activity, not a merge step." Each strand was
# locally correct; the failures that survive to here are the ones where the COMBINATION
# is wrong. This script runs the thing no single strand could run — the whole pipeline
# with every strand present, in release order, on the release runtime.
#
# Exit non-zero on the first failure. A red `dev` may never cross a session boundary
# (§C.5.3): if it is not obviously fixable inside the six-hour stuck rule, revert the
# merge rather than leaving it red.

set -euo pipefail
cd "$(dirname "$0")/.."

PY=.venv/bin/python
fail=0
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
check() { if "$@"; then echo "  ok"; else echo "  FAILED: $*"; fail=1; fi; }

step "1. Frozen files unchanged since the seam-freeze"
FROZEN=(
  web/src/app/kernel.ts
  web/src/app/contracts.ts
  web/src/main.ts
  web/src/render/geometry.ts
  web/src/render/rng.ts
  web/src/render/units.ts
  web/src/types/document.d.ts
  assignment_helper/app.py
  assignment_helper/security.py
  assignment_helper/document/schema.py
  assignment_helper/document/store.py
)
FREEZE_TAG=${FREEZE_TAG:-f1322a7}
for f in "${FROZEN[@]}"; do
  if ! git diff --quiet "$FREEZE_TAG" -- "$f"; then
    echo "  CHANGED: $f — a strand edited a frozen file. This is a contract bug, not a merge."
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "  ok — all ${#FROZEN[@]} frozen files intact"

step "2. Generated types match the schema"
check $PY scripts/gen_types.py --check

step "3. Python tests"
check $PY -m pytest tests -q

step "4. I17 — the CV stack is unreachable from the serve and render paths"
check .venv/bin/lint-imports

step "5. Python lint"
check $PY -m ruff check assignment_helper scripts

step "6. TypeScript types"
check npx tsc --noEmit

step "7. TypeScript tests"
check npx vitest run --config vitest.config.ts

step "8. I1 — no banned global under render/**"
if grep -rnE '\b(Math\.random|new Date|Date\.now|performance\.now|crypto\.getRandomValues)\b' web/src/render/ 2>/dev/null; then
  echo "  FAILED: geometry determinism is broken by the hits above (invariant I1)."
  echo "  Instrumentation belongs in kernel.ts, which is outside the banned tree."
  fail=1
else
  echo "  ok"
fi

step "9. I5 — no silent failure"
# Catches `except: pass` AND the typed form `except ValueError:\n    pass`, which the
# first version of this grep missed and ruff's SIM105 found for us.
if grep -rnzoE 'except[^\n]*:\n[[:space:]]*pass' assignment_helper/ 2>/dev/null | tr '\\0' '\\n' | grep -q .; then
  echo "  FAILED: a swallowed exception above (invariant I5)."; fail=1
elif grep -rnE 'catch\s*\([^)]*\)\s*\{\s*\}' web/src/ 2>/dev/null; then
  echo "  FAILED: an empty catch above (invariant I5)."; fail=1
else
  echo "  ok"
fi

step "10. The bundle builds"
check npm run build

step "11. No handwriting sample, personal font or build artifact is tracked"
if git ls-files | grep -E '^(samples/|out/|fonts/personal/)|\.(ttf|otf)$' | grep -vE '^(web/public/fonts/reference/|spikes/m0/fonts/)'; then
  echo "  FAILED: the files above must never be committed — this repo is public."; fail=1
else
  echo "  ok"
fi

echo
if [ $fail -eq 0 ]; then
  echo -e "\033[32mINTEGRATION GREEN\033[0m — tag it: git tag known-good-$(date +%Y%m%d)"
else
  echo -e "\033[31mINTEGRATION RED\033[0m — fix inside the six-hour stuck rule, or revert the merge."
  exit 1
fi
