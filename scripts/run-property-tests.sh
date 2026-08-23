#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MARKER='Feature: bulk-csv-report-email, Property'
SEARCH_DIRS=(packages/backend/src packages/frontend/src)

property_files=()
while IFS= read -r file; do
  property_files+=("$file")
done < <(
  grep -RIlF \
    --include='*.test.ts' \
    --include='*.test.tsx' \
    "$MARKER" "${SEARCH_DIRS[@]}" || true
)

if [[ ${#property_files[@]} -eq 0 ]]; then
  echo "No bulk CSV report property tests were found." >&2
  exit 1
fi

for property_number in $(seq 1 25); do
  count="$({ grep -RhF \
    --include='*.test.ts' \
    --include='*.test.tsx' \
    "${MARKER} ${property_number}:" "${SEARCH_DIRS[@]}" || true; } | wc -l | tr -d ' ')"
  if [[ "$count" != "1" ]]; then
    echo "Property ${property_number} must have exactly one feature marker; found ${count}." >&2
    exit 1
  fi
done

total_markers="$({ grep -RhF \
  --include='*.test.ts' \
  --include='*.test.tsx' \
  "$MARKER" "${SEARCH_DIRS[@]}" || true; } | wc -l | tr -d ' ')"
if [[ "$total_markers" != "25" ]]; then
  echo "Expected exactly 25 property markers; found ${total_markers}." >&2
  exit 1
fi

backend_files=()
frontend_files=()
for file in "${property_files[@]}"; do
  case "$file" in
    packages/backend/*) backend_files+=("${file#packages/backend/}") ;;
    packages/frontend/*) frontend_files+=("${file#packages/frontend/}") ;;
  esac
done

if [[ ${#backend_files[@]} -eq 0 || ${#frontend_files[@]} -eq 0 ]]; then
  echo "Property tests must include both backend and frontend suites." >&2
  exit 1
fi

(
  cd packages/backend
  npx --no-install vitest run "${backend_files[@]}"
)
(
  cd packages/frontend
  npx --no-install vitest run "${frontend_files[@]}"
)
