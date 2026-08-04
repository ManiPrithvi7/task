#!/usr/bin/env bash
# Run each test file in its own bun process so jest.mock() in one file cannot leak into others.
set -euo pipefail

root="${1:-tests/unit}"

find "$root" -name '*.test.ts' -print | sort | while IFS= read -r file; do
  bun test "$file"
done
