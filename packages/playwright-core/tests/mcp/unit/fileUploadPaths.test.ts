/**
 * Unit tests for browser_file_upload path normalization and validation.
 *
 * Tests cover every path format the tool must accept:
 *   - Windows drive-letter (backslash, forward slash, mixed case)
 *   - UNC wsl$ (backslash and forward slash variants)
 *   - POSIX /mnt/..., /home/..., /tmp/...
 *   - Tilde expansion
 *   - Wrapping-quote stripping
 *
 * Also covers: wslpath fallback (wslpath unavailable), non-existent file
 * errors (citing both original + resolved paths), permission errors,
 * non-WSL Windows path rejection.
 *
 * Mocking strategy:
 *   - `vi.mock('fs', ...)` and `vi.mock('child_process', ...)` are hoisted
 *     by vitest before imports, so the mocks are in place when files.ts loads.
 *   - _resetWSLCache() is exported from files.ts specifically for tests — it
 *     clears the module-level isWSL() cache so each test can set its own WSL
 *     environment. Call it in beforeEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';

// ---------------------------------------------------------------------------
// vi.mock declarations — MUST be top-level (vitest hoists them before imports)
// ---------------------------------------------------------------------------

// Mutable state shared with mock factories below
const mockState = {
  isWSL: true,
  wslpathResult: null as string | null,
  wslpathThrowsEnoent: false,
  statResult: 'file' as 'file' | 'directory' | 'enoent' | 'eacces' | 'other',
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: (filePath: any, _options?: any) => {
      if (filePath === '/proc/version')
        return mockState.isWSL ? 'Linux version 5.15 (microsoft-standard-WSL2)' : 'Linux version 5.15 (generic)';
      return actual.readFileSync(filePath, _options);
    },
    promises: {
      ...actual.promises,
      stat: async (_p: string) => {
        if (mockState.statResult === 'enoent')
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        if (mockState.statResult === 'eacces')
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        if (mockState.statResult === 'other')
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        if (mockState.statResult === 'directory')
          return { isDirectory: () => true };
        return { isDirectory: () => false };
      },
    },
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (cmd: string, args: string[], _opts?: any) => {
      if (cmd === 'wslpath') {
        if (mockState.wslpathThrowsEnoent)
          throw Object.assign(new Error('spawn wslpath ENOENT'), { code: 'ENOENT' });
        if (mockState.wslpathResult !== null)
          return mockState.wslpathResult + '\n';
        // Not configured — shouldn't be called; throw to surface test bug
        throw new Error(`execFileSync(wslpath) called unexpectedly with args ${JSON.stringify(args)}`);
      }
      return actual.execFileSync(cmd, args as any, _opts as any);
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { normalizePath, validatePaths, _resetWSLCache } from 'playwright-core/src/tools/files';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setWSL(active: boolean) {
  mockState.isWSL = active;
  _resetWSLCache();
}

function setWslpathSuccess(output: string) {
  mockState.wslpathResult = output;
  mockState.wslpathThrowsEnoent = false;
}

function setWslpathMissing() {
  mockState.wslpathResult = null;
  mockState.wslpathThrowsEnoent = true;
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState.isWSL = true;
  mockState.wslpathResult = null;
  mockState.wslpathThrowsEnoent = false;
  mockState.statResult = 'file';
  _resetWSLCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// normalizePath — Windows drive-letter paths (wslpath available)
// ---------------------------------------------------------------------------

describe('normalizePath — Windows drive-letter paths via wslpath', () => {
  beforeEach(() => setWSL(true));

  it('converts C:\\Users\\...\\file.pdf', () => {
    setWslpathSuccess('/mnt/c/Users/FaroukBakari/Downloads/file.pdf');
    expect(normalizePath('C:\\Users\\FaroukBakari\\Downloads\\file.pdf'))
        .toBe('/mnt/c/Users/FaroukBakari/Downloads/file.pdf');
  });

  it('converts C:/Users/.../file.pdf (forward slashes)', () => {
    setWslpathSuccess('/mnt/c/Users/FaroukBakari/Downloads/file.pdf');
    expect(normalizePath('C:/Users/FaroukBakari/Downloads/file.pdf'))
        .toBe('/mnt/c/Users/FaroukBakari/Downloads/file.pdf');
  });

  it('converts lowercase drive letter c:\\users\\test\\file.pdf', () => {
    setWslpathSuccess('/mnt/c/users/test/file.pdf');
    expect(normalizePath('c:\\users\\test\\file.pdf'))
        .toBe('/mnt/c/users/test/file.pdf');
  });

  it('converts D:\\ drive letter', () => {
    setWslpathSuccess('/mnt/d/work/file.txt');
    expect(normalizePath('D:\\work\\file.txt'))
        .toBe('/mnt/d/work/file.txt');
  });

  it('strips wrapping double-quotes before converting', () => {
    setWslpathSuccess('/mnt/c/Users/test/file.pdf');
    expect(normalizePath('"C:\\Users\\test\\file.pdf"'))
        .toBe('/mnt/c/Users/test/file.pdf');
  });

  it('strips wrapping single-quotes before converting', () => {
    setWslpathSuccess('/mnt/c/Users/test/file.pdf');
    expect(normalizePath("'C:\\Users\\test\\file.pdf'"))
        .toBe('/mnt/c/Users/test/file.pdf');
  });
});

// ---------------------------------------------------------------------------
// normalizePath — Windows drive-letter paths (wslpath fallback)
// ---------------------------------------------------------------------------

describe('normalizePath — Windows drive-letter paths, wslpath fallback', () => {
  beforeEach(() => {
    setWSL(true);
    setWslpathMissing();
  });

  it('falls back to regex: C:\\Users\\...', () => {
    expect(normalizePath('C:\\Users\\FaroukBakari\\Downloads\\file.pdf'))
        .toBe('/mnt/c/Users/FaroukBakari/Downloads/file.pdf');
  });

  it('falls back to regex: C:/Users/... (forward slashes)', () => {
    expect(normalizePath('C:/Users/FaroukBakari/Downloads/file.pdf'))
        .toBe('/mnt/c/Users/FaroukBakari/Downloads/file.pdf');
  });

  it('lowercases the drive letter in fallback', () => {
    expect(normalizePath('D:\\Work\\report.xlsx'))
        .toBe('/mnt/d/Work/report.xlsx');
  });
});

// ---------------------------------------------------------------------------
// normalizePath — UNC wsl$ paths (wslpath available)
// ---------------------------------------------------------------------------

describe('normalizePath — UNC wsl$ paths via wslpath', () => {
  beforeEach(() => setWSL(true));

  it('converts \\\\wsl$\\Ubuntu\\home\\farouk\\file.pdf', () => {
    setWslpathSuccess('/home/farouk/file.pdf');
    expect(normalizePath('\\\\wsl$\\Ubuntu\\home\\farouk\\file.pdf'))
        .toBe('/home/farouk/file.pdf');
  });

  it('converts //wsl$/Ubuntu/home/farouk/file.pdf (forward slashes)', () => {
    setWslpathSuccess('/home/farouk/file.pdf');
    expect(normalizePath('//wsl$/Ubuntu/home/farouk/file.pdf'))
        .toBe('/home/farouk/file.pdf');
  });

  it('converts //wsl.localhost/Ubuntu/home/farouk/file.pdf', () => {
    setWslpathSuccess('/home/farouk/file.pdf');
    expect(normalizePath('//wsl.localhost/Ubuntu/home/farouk/file.pdf'))
        .toBe('/home/farouk/file.pdf');
  });
});

// ---------------------------------------------------------------------------
// normalizePath — UNC wsl$ paths (wslpath fallback)
// ---------------------------------------------------------------------------

describe('normalizePath — UNC wsl$ paths, wslpath fallback', () => {
  beforeEach(() => {
    setWSL(true);
    setWslpathMissing();
  });

  it('falls back to regex strip for \\\\wsl$\\Ubuntu\\...', () => {
    expect(normalizePath('\\\\wsl$\\Ubuntu\\home\\farouk\\file.pdf'))
        .toBe('/home/farouk/file.pdf');
  });

  it('falls back to regex strip for //wsl$/Ubuntu/...', () => {
    expect(normalizePath('//wsl$/Ubuntu/home/farouk/file.pdf'))
        .toBe('/home/farouk/file.pdf');
  });

  it('throws for non-wsl$ UNC path when wslpath missing', () => {
    expect(() => normalizePath('\\\\server\\share\\file.pdf'))
        .toThrow('could not be converted');
  });
});

// ---------------------------------------------------------------------------
// normalizePath — POSIX paths (passthrough, no conversion)
// ---------------------------------------------------------------------------

describe('normalizePath — POSIX paths passthrough', () => {
  beforeEach(() => setWSL(true));

  it('passes through /mnt/c/Users/test/file.pdf unchanged', () => {
    // wslpath must NOT be called — set it to null to catch accidental invocations
    mockState.wslpathResult = null;
    mockState.wslpathThrowsEnoent = false;
    expect(normalizePath('/mnt/c/Users/test/file.pdf'))
        .toBe('/mnt/c/Users/test/file.pdf');
  });

  it('passes through /home/farouk/file.pdf unchanged', () => {
    expect(normalizePath('/home/farouk/file.pdf'))
        .toBe('/home/farouk/file.pdf');
  });

  it('passes through /tmp/upload.zip unchanged', () => {
    expect(normalizePath('/tmp/upload.zip'))
        .toBe('/tmp/upload.zip');
  });

  it('expands ~ to home directory', () => {
    const home = os.homedir().replace(/\\/g, '/');
    expect(normalizePath('~/Downloads/file.pdf'))
        .toBe(`${home}/Downloads/file.pdf`);
  });
});

// ---------------------------------------------------------------------------
// normalizePath — non-WSL environment rejects Windows/UNC paths
// ---------------------------------------------------------------------------

describe('normalizePath — non-WSL rejects Windows/UNC paths', () => {
  beforeEach(() => setWSL(false));

  it('throws for Windows drive-letter path on non-WSL', () => {
    expect(() => normalizePath('C:\\Users\\test\\file.pdf'))
        .toThrow('not running under WSL');
  });

  it('throws for UNC path on non-WSL', () => {
    expect(() => normalizePath('\\\\wsl$\\Ubuntu\\home\\farouk\\file.pdf'))
        .toThrow('not running under WSL');
  });
});

// ---------------------------------------------------------------------------
// validatePaths — error messages cite both original and resolved paths
// ---------------------------------------------------------------------------

describe('validatePaths — error messages', () => {
  it('cites original Windows path and resolved POSIX path on ENOENT', async () => {
    mockState.statResult = 'enoent';
    const resolved = '/mnt/c/Users/test/ghost.pdf';
    const original = 'C:\\Users\\test\\ghost.pdf';
    const originalPaths = new Map([[resolved, original]]);

    const err = await validatePaths([resolved], originalPaths).catch(e => e);
    expect(err.message).toMatch('File not found');
    expect(err.message).toMatch(resolved);
    expect(err.message).toMatch(/original input.*C:\\Users\\test\\ghost\.pdf/);
    expect(err.message).toMatch(/resolved to.*\/mnt\/c\/Users\/test\/ghost\.pdf/);
  });

  it('cites only the POSIX path when no conversion occurred', async () => {
    mockState.statResult = 'enoent';
    const resolved = '/tmp/does-not-exist.pdf';
    const originalPaths = new Map<string, string>();

    const err = await validatePaths([resolved], originalPaths).catch(e => e);
    expect(err.message).toMatch('File not found: "/tmp/does-not-exist.pdf"');
    expect(err.message).not.toMatch('original input');
  });

  it('cites original path context on permission denied', async () => {
    mockState.statResult = 'eacces';
    const resolved = '/mnt/c/Users/test/locked.pdf';
    const original = 'C:\\Users\\test\\locked.pdf';
    const originalPaths = new Map([[resolved, original]]);

    const err = await validatePaths([resolved], originalPaths).catch(e => e);
    expect(err.message).toMatch('Permission denied');
    expect(err.message).toMatch(/original input/);
  });

  it('reports directory-instead-of-file error', async () => {
    mockState.statResult = 'directory';
    const resolved = '/tmp/a-directory';

    const err = await validatePaths([resolved], new Map()).catch(e => e);
    expect(err.message).toMatch('Expected a file but got a directory');
  });

  it('passes for a file that exists', async () => {
    mockState.statResult = 'file';
    await expect(validatePaths(['/tmp/exists.pdf'], new Map())).resolves.toBeUndefined();
  });
});
