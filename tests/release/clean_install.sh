#!/usr/bin/env bash
# Clean-install test. Plan §9.
#
# "Works on my machine" is the default state of a dev checkout, and every one of the
# failures this catches is invisible from inside one: a missing bundle, a dependency
# that was only ever installed because the dev venv had it, a console script that does
# not exist, an import that resolves from the source tree rather than the wheel.
#
# Both halves must be green: this script, and /selftest in a browser, which runs the
# canvas gates (I12 readback fidelity, canvas size cap, OffscreenCanvas, ctx.filter).

set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "clean room: $TMP"

echo "== build the wheel (bundle included) =="
npm run build
uv build --out-dir "$TMP/dist"
WHEEL=$(ls "$TMP"/dist/*.whl)
echo "  $WHEEL"

echo "== the wheel actually contains the bundle =="
# The single most likely release failure: .gitignore ignores assignment_helper/static/,
# so a wheel built from a clean checkout without `npm run build` ships a server that
# serves a 500 instead of an app.
if ! unzip -l "$WHEEL" | grep -q 'assignment_helper/static/index.html'; then
  echo "  FAILED: no static/index.html in the wheel. Run npm run build first."
  exit 1
fi
echo "  ok"

echo "== install into a fresh tool dir, with node and the dev checkout off PATH =="
export UV_TOOL_DIR="$TMP/tools"
export UV_TOOL_BIN_DIR="$TMP/bin"
CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node | grep -v "$REPO" | paste -sd: -)
env -i HOME="$TMP" PATH="$CLEAN_PATH:$TMP/bin" UV_TOOL_DIR="$UV_TOOL_DIR" \
    UV_TOOL_BIN_DIR="$UV_TOOL_BIN_DIR" \
    "$(command -v uv)" tool install --python 3.14 "$WHEEL"

echo "== --selftest =="
env -i HOME="$TMP" PATH="$CLEAN_PATH:$TMP/bin" "$TMP/bin/assignment-helper" --selftest

echo
echo "CLEAN INSTALL GREEN"
echo "Second half, by hand: launch it and open /selftest in a browser."
