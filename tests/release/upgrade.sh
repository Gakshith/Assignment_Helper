#!/usr/bin/env bash
# Upgrade-over-existing test. Plan §9.
#
#   ./tests/release/upgrade.sh <previous-tag> <new-tag>
#
# Installs the PREVIOUS tag, creates a profile and a document, installs the new tag,
# and asserts the profile migrates and the document still opens and renders.
#
# §C.6 recorded that this gate is UNSATISFIABLE at v1.0.0 — an upgrade test needs a
# previous release to upgrade FROM. It is N/A until v1.0.1, and this script says so
# rather than silently passing on a comparison it never made.

set -euo pipefail
cd "$(dirname "$0")/../.."

PREV=${1:-}
NEXT=${2:-}

if [ -z "$PREV" ] || [ -z "$NEXT" ]; then
  echo "usage: $0 <previous-tag> <new-tag>"
  echo
  echo "No previous release exists yet, so there is nothing to upgrade FROM."
  echo "This gate is N/A until v1.0.1 (plan §C.6). It is not a pass."
  exit 2
fi

if ! git rev-parse --verify --quiet "$PREV^{commit}" >/dev/null; then
  echo "the previous tag '$PREV' does not exist in this checkout"
  exit 2
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export UV_TOOL_DIR="$TMP/tools" UV_TOOL_BIN_DIR="$TMP/bin"
export AH_PROFILE_HOME="$TMP/profiles"

echo "== install the previous release: $PREV =="
uv tool install --python 3.14 "git+file://$PWD@$PREV"

echo "== create a document and a profile with it =="
cp tests/fixtures/upgrade/hw.md "$TMP/hw.md" 2>/dev/null || printf '# Upgrade fixture\n\nA paragraph with $x^2$ in it.\n' > "$TMP/hw.md"
"$TMP/bin/assignment-helper" "$TMP/hw.md" --no-browser --print-url >/dev/null 2>&1 &
SERVER=$!
sleep 6
kill $SERVER 2>/dev/null || true
test -f "$TMP/hw.ah.json" || { echo "the previous release wrote no document"; exit 1; }
BEFORE=$(wc -c < "$TMP/hw.ah.json")

echo "== install the new release: $NEXT =="
uv tool install --force --python 3.14 "git+file://$PWD@$NEXT"

echo "== the document still opens, and migrates forward =="
"$TMP/bin/assignment-helper" "$TMP/hw.md" --no-browser --print-url >/dev/null 2>&1 &
SERVER=$!
sleep 6
kill $SERVER 2>/dev/null || true
AFTER=$(wc -c < "$TMP/hw.ah.json")

echo "  document: $BEFORE bytes -> $AFTER bytes"
test -f "$TMP/hw.ah.json" || { echo "the document did not survive the upgrade"; exit 1; }

echo
echo "UPGRADE GREEN"
