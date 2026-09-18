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
steps_run=0
TOTAL_STEPS=11
step() { steps_run=$((steps_run + 1)); printf '\n\033[1m== %s\033[0m\n' "$1"; }
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
# An annotated tag, not a hardcoded sha, so re-baselining is a deliberate, recorded act.
# Move it ONLY with a commit that says what changed in a frozen file and why.
FREEZE_TAG=${FREEZE_TAG:-seam-freeze}
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
# NEVER run this with --fix --unsafe-fixes across the tree. Doing so once silently
# rewrote the frozen document/schema.py (PEP 604 unions) and only check 1 noticed.
# A formatter is as capable of editing a frozen file as a strand is.
check $PY -m ruff check assignment_helper scripts

step "6. TypeScript types"
check npx tsc --noEmit

step "7. TypeScript tests"
check npx vitest run --config vitest.config.ts

step "8. I1 — no banned global under render/**"
# Comment-blind greps punish documentation. The paper strand's first draft failed this
# check for writing "never call performance.now() here" in a doc comment - i.e. for
# saying the right thing. That teaches strands to stop explaining themselves.
#
# Comments are stripped BEFORE matching: whole-line // and * and /* lines are dropped,
# and a trailing // comment is cut from the line. What remains is code.
BANNED='\b(Math\.random|new Date|Date\.now|performance\.now|crypto\.getRandomValues)\b'
i1_hits=$(
  find web/src/render -name '*.ts' -print0 2>/dev/null |
  while IFS= read -r -d '' f; do
    sed -e 's@//.*$@@' -e '/^[[:space:]]*[*]/d' -e '/^[[:space:]]*\/\*/d' "$f" |
      grep -nE "$BANNED" | sed "s@^@$f:@"
  done
) || true
if [ -n "$i1_hits" ]; then
  echo "$i1_hits"
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
# Guard against this script dying quietly. `set -e` plus any command that legitimately
# exits non-zero (grep finding nothing) will abort mid-run, and an abort that returns 0
# reports GREEN while having skipped checks. That happened, in step 8, and it is the
# same silent failure the script exists to catch.
if [ "$steps_run" -ne "$TOTAL_STEPS" ]; then
  echo -e "\033[31mHARNESS ABORTED\033[0m — ran $steps_run of $TOTAL_STEPS checks."
  echo "  Do not read this as a pass. Fix the harness first."
  exit 2
fi

if [ $fail -eq 0 ]; then
  echo -e "\033[32mINTEGRATION GREEN\033[0m — tag it: git tag known-good-$(date +%Y%m%d)"
else
  echo -e "\033[31mINTEGRATION RED\033[0m — fix inside the six-hour stuck rule, or revert the merge."
  exit 1
fi
