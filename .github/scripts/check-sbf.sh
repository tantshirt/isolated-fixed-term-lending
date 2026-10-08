#!/usr/bin/env bash
# LLVM can print an SBF stack violation while cargo still exits successfully.
set -euo pipefail
build_log=$(mktemp)
trap 'rm -f "$build_log"' EXIT
set +e
"$@" 2>&1 | tee "$build_log"
build_status=${PIPESTATUS[0]}
set -e
if grep -Ei 'Stack offset .*exceeded max offset|stack frame size .*exceeds|stack size .*exceeded|function call .*overwrites values in the frame' "$build_log"; then
  echo 'SBF stack limit exceeded; refusing this artifact.' >&2
  exit 1
fi
exit "$build_status"
