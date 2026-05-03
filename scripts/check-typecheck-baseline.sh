#!/usr/bin/env bash
# check-typecheck-baseline.sh — Pre-commit hook: block type error regression
#
# Runs tsc --noEmit, counts errors, compares against typecheck-baseline.json.
# Blocks commit on regression (more errors), auto-updates baseline on
# improvement (fewer errors), passes silently on equal count.
#
# Event: pre-commit (via playwright/.pre-commit-config.yaml)
# Prerequisites: node 22 (fnm-managed), tsc (npx)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE="$REPO_ROOT/typecheck-baseline.json"

# Early exit — no baseline committed yet
if [[ ! -f "$BASELINE" ]]; then
    echo "typecheck-ratchet: no baseline found, skipping"
    exit 0
fi

# Run tsc and capture error count
tsc_output="$(cd "$REPO_ROOT" && npx tsc --noEmit 2>&1 || true)"
current_count="$(echo "$tsc_output" | grep -c '^packages/' || echo 0)"

# Read baseline
baseline_count="$(node -e "console.log(require('$BASELINE').errorCount)")"

if [[ "$current_count" -gt "$baseline_count" ]]; then
    echo "REGRESSION: type errors increased: $baseline_count → $current_count"
    echo ""
    # Show only new-looking errors (all errors, user can diff)
    echo "$tsc_output" | grep '^packages/' | tail -20
    echo ""
    echo "Type error regression detected. Fix the new type errors before committing."
    exit 1
elif [[ "$current_count" -lt "$baseline_count" ]]; then
    echo "IMPROVED: type errors decreased: $baseline_count → $current_count"
    node -e "
        const b = { errorCount: $current_count, updatedAt: new Date().toISOString().slice(0, 10) };
        require('fs').writeFileSync('$BASELINE', JSON.stringify(b, null, 2) + '\n');
    "
    git -C "$REPO_ROOT" add typecheck-baseline.json
    echo "Baseline auto-updated and staged."
fi

# Equal count = silent pass (no new errors introduced)
