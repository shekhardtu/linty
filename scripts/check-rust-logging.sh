#!/usr/bin/env bash
# Fails when app code prints instead of logging.
#
# Linty's backend logs through the `log` crate (src-tauri/src/logging.rs) so
# output reaches the local log file and follows the redaction rule: never log
# transcript text, clipboard contents, API keys or dictionary words.
# build.rs and examples/ are exempt; they are not part of the app.
set -euo pipefail

cd "$(dirname "$0")/.."

src_dir=src-tauri/src
# Some grep builds treat a missing directory as "no match", so check first.
if [ ! -d "$src_dir" ] || [ -z "$(find "$src_dir" -name '*.rs' -print -quit)" ]; then
  echo "No Rust sources under $src_dir; nothing was scanned." >&2
  exit 2
fi

pattern='\b(e?print(ln)?|dbg)!\s*\('
# grep exits 0 on a match, 1 on no match and 2 or more on an error.
status=0
matches=$(grep -rnE "$pattern" "$src_dir" --include='*.rs') || status=$?
case "$status" in
  0)
    echo "Use log::{error,warn,info,debug}! instead of print macros:"
    echo "$matches"
    exit 1
    ;;
  1)
    echo "No print macros in $src_dir."
    ;;
  *)
    echo "grep failed (exit $status); $src_dir was not scanned." >&2
    exit "$status"
    ;;
esac
