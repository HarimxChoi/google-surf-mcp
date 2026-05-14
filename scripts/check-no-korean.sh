#!/bin/sh
# Fail on Korean in src/*.ts unless the line is tagged `i18n-data`.
# Usage: check-no-korean.sh [files...]   (no args = scan all of src/)
export LC_ALL=C.UTF-8 # so grep -P reads \x{} under POSIX locale
if [ "$#" -gt 0 ]; then
  files=$*
else
  files=$(find src -name '*.ts')
fi
status=0
for f in $files; do
  case "$f" in src/*.ts) ;; *) continue ;; esac
  [ -f "$f" ] || continue
  bad=$(grep -nP '[\x{AC00}-\x{D7A3}]' "$f" | grep -v 'i18n-data' || true)
  if [ -n "$bad" ]; then
    echo "[no-korean] $f:"
    echo "$bad"
    status=1
  fi
done
[ "$status" -ne 0 ] && echo "[no-korean] tag i18n data with an 'i18n-data' comment, or use English."
exit $status
