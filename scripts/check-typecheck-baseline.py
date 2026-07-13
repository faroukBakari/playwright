# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Pre-commit hook: block type error regression for the playwright fork.

Runs tsc --noEmit at repo root, counts errors, compares against
typecheck-baseline.json. Blocks commit on regression, auto-updates
baseline on improvement, passes silently on equal count.

Event: pre-commit (via playwright/.pre-commit-config.yaml)
Prerequisites: node 22 (fnm-managed), tsc (npx)
"""

import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
BASELINE = REPO_ROOT / "typecheck-baseline.json"
IS_WINDOWS = sys.platform.startswith("win")
NODE_MAJOR = "22"


def count_errors(output: str) -> int:
    return sum(1 for line in output.splitlines() if line.startswith("packages/"))


def read_baseline() -> int:
    data = json.loads(BASELINE.read_text(encoding="utf-8"))
    return int(data["errorCount"])


def write_baseline(count: int) -> None:
    data = {"errorCount": count, "updatedAt": date.today().isoformat()}
    BASELINE.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    if not BASELINE.exists():
        print("typecheck-ratchet: no baseline found, skipping")
        return 0

    fnm = shutil.which("fnm")
    if not fnm:
        print("typecheck-ratchet: fnm not found on PATH", file=sys.stderr)
        return 127

    inner = ["npx", "tsc", "--noEmit"]
    if IS_WINDOWS:
        cmd = [fnm, "exec", "--using", NODE_MAJOR, "--", "cmd", "/c", *inner]
    else:
        cmd = [fnm, "exec", "--using", NODE_MAJOR, "--", *inner]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    tsc_output = result.stdout + result.stderr

    current_count = count_errors(tsc_output)
    baseline_count = read_baseline()

    if current_count > baseline_count:
        print(f"REGRESSION: type errors increased: {baseline_count} → {current_count}")
        print()
        error_lines = [l for l in tsc_output.splitlines() if l.startswith("packages/")]
        print("\n".join(error_lines[-20:]))
        print()
        print("Type error regression detected. Fix the new type errors before committing.")
        return 1

    if current_count < baseline_count:
        print(f"IMPROVED: type errors decreased: {baseline_count} → {current_count}")
        write_baseline(current_count)
        subprocess.run(
            ["git", "-C", str(REPO_ROOT), "add", "typecheck-baseline.json"],
            check=True,
        )
        print("Baseline auto-updated and staged.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
