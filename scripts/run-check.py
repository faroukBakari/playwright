#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# Pre-commit hook: run a package check (lint / typecheck / test) cross-platform.
#
# Replaces `bash -c 'fnm exec --using 22 -- npx ...'` which fails on Windows
# because fnm exec spawns the target via CreateProcess and does not honor
# PATHEXT — `.cmd` shims (npx, pnpm) resolve to "program not found".
# Routes through `cmd /c` on Windows, mirroring playwright-mcp's run-check.py.

import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
NODE_MAJOR = "22"
IS_WINDOWS = sys.platform.startswith("win")

CHECKS: dict[str, tuple[str, list[str]]] = {
    "eslint": (".", ["npx", "eslint", *sys.argv[2:]]),
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in CHECKS:
        print(f"usage: {sys.argv[0]} {{{' | '.join(CHECKS)}}}", file=sys.stderr)
        return 2

    fnm = shutil.which("fnm")
    if not fnm:
        print("fnm not found on PATH", file=sys.stderr)
        return 127

    pkg_dir, inner = CHECKS[sys.argv[1]]
    cwd = REPO_ROOT / pkg_dir

    if IS_WINDOWS:
        cmd = [fnm, "exec", "--using", NODE_MAJOR, "--", "cmd", "/c", *inner]
    else:
        cmd = [fnm, "exec", "--using", NODE_MAJOR, "--", *inner]

    return subprocess.run(cmd, cwd=cwd, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
