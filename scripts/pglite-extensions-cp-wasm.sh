#!/usr/bin/env bash
set -euo pipefail

root_dir="${1:-}"
postgrespglite_dir="${2:-}"

if [[ -z "$root_dir" || ! -d "$root_dir" || -z "$postgrespglite_dir" || ! -d "$postgrespglite_dir" ]]; then
  echo "Usage: $0 <pglite extensions folder> <postgres-pglite folder>" >&2
  exit 1
fi

for dir in "$root_dir"/pglite-*; do
  [[ -d "$dir" ]] || continue

  folder_name="$(basename "$dir")"
  suffix="${folder_name#pglite-}"

  # Skip if it doesn't actually start with pglite-
  [[ "$suffix" != "$folder_name" ]] || continue

  # the bundle named like the package, else one whose name starts like it
  # (with only a prefix, timescaledb would also match timescaledb_toolkit)
  bundle="$postgrespglite_dir"/dist/extensions/other/"$suffix".tar.gz
  [[ -f "$bundle" ]] || bundle=$(ls "$postgrespglite_dir"/dist/extensions/other/"$suffix"*.tar.gz)

  mkdir -p "$root_dir"/"$folder_name"/release && cp "$bundle" "$root_dir"/"$folder_name"/release/"$suffix".tar.gz
done
