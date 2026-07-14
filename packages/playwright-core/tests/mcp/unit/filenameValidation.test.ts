import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { validateFilename, Response } from 'playwright-core/src/tools/response';
import evaluateTools from 'playwright-core/src/tools/evaluate';
import runCodeTools from 'playwright-core/src/tools/runCode';

// ---------------------------------------------------------------------------
// validateFilename — pure function tests
// ---------------------------------------------------------------------------

describe('validateFilename', () => {
  it('accepts simple filenames', () => {
    expect(() => validateFilename('result.json')).not.toThrow();
    expect(() => validateFilename('my-data.txt')).not.toThrow();
    expect(() => validateFilename('output_2026.csv')).not.toThrow();
  });

  it('accepts filenames with dots and dashes', () => {
    expect(() => validateFilename('file.name.with.dots.json')).not.toThrow();
    expect(() => validateFilename('a-b-c-d')).not.toThrow();
  });

  it('rejects forward slash (path traversal)', () => {
    expect(() => validateFilename('../etc/passwd')).toThrow('path separators');
    expect(() => validateFilename('foo/bar.json')).toThrow('path separators');
    expect(() => validateFilename('/absolute')).toThrow('path separators');
  });

  it('rejects backslash (Windows path traversal)', () => {
    expect(() => validateFilename('..\\etc\\passwd')).toThrow('path separators');
    expect(() => validateFilename('foo\\bar.json')).toThrow('path separators');
  });

  it('rejects mixed separators', () => {
    expect(() => validateFilename('..\\foo/bar')).toThrow('path separators');
  });
});

// ---------------------------------------------------------------------------
// resolveClientFile — integration with Response
// ---------------------------------------------------------------------------

function createStubContext(configOverrides: Record<string, any> = {}) {
  return {
    id: 'test-context-id',
    config: { ...configOverrides },
    options: { cwd: '/tmp' },
    currentTab: () => undefined,
    tabs: () => [],
    workspaceFile: vi.fn(async (name: string) => `/tmp/${name}`),
    outputFile: vi.fn(async () => '/tmp/auto-generated.txt'),
  } as any;
}

describe('resolveClientFile validates filename', () => {
  it('rejects suggestedFilename with path separators', async () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_console_messages', {});

    await expect(
        response.resolveClientFile(
            { prefix: 'console', ext: 'log', suggestedFilename: '../traversal.log' },
            'Console'
        )
    ).rejects.toThrow('path separators');

    // workspaceFile should never be called — validation fires first
    expect(ctx.workspaceFile).not.toHaveBeenCalled();
  });

  it('allows clean suggestedFilename through', async () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_console_messages', {});

    const result = await response.resolveClientFile(
        { prefix: 'console', ext: 'log', suggestedFilename: 'my-console.log' },
        'Console'
    );

    expect(ctx.workspaceFile).toHaveBeenCalledWith('my-console.log', '/tmp');
    expect(result.fileName).toBe('/tmp/my-console.log');
  });

  it('skips validation when no suggestedFilename (auto-generated path)', async () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_snapshot', {});

    const result = await response.resolveClientFile(
        { prefix: 'page', ext: 'yml' },
        'Snapshot'
    );

    expect(ctx.outputFile).toHaveBeenCalled();
    expect(result.fileName).toBe('/tmp/auto-generated.txt');
  });
});

// ---------------------------------------------------------------------------
// addFileResult — file write + text result
// ---------------------------------------------------------------------------

describe('addFileResult writes file and returns link', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes string data to file', async () => {
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_evaluate', {});

    await response.addFileResult(
        { fileName: '/tmp/test.json', relativeName: '/tmp/test.json', printableLink: '- [Result](/tmp/test.json)' },
        '{"title":"Example"}'
    );

    expect(writeSpy).toHaveBeenCalledWith('/tmp/test.json', '{"title":"Example"}', 'utf-8');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: evaluate handler → real Response → fs.writeFile
// ---------------------------------------------------------------------------

describe('evaluate filename end-to-end (real Response)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes evaluate result to /tmp/<filename> via fs.writeFile', async () => {
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    const ctx = createStubContext();

    const mockTab = {
      page: { _evaluateFunction: vi.fn().mockResolvedValue('{"scraped":"data"}') },
      context: ctx,
      modalStates: () => [],
    };

    // Real Response object — not mocked
    const response = new Response(ctx, 'browser_evaluate', {});

    const tool = evaluateTools[0];
    await tool.handle(
        { ensureTab: vi.fn(async () => mockTab) } as any,
        { function: '() => "test"', filename: 'scrape-result.json' },
        response as any
    );

    // The file must be written to os.tmpdir()/<filename>
    expect(writeSpy).toHaveBeenCalledWith(
        path.join(os.tmpdir(), 'scrape-result.json'),
        '{"scraped":"data"}',
        'utf-8'
    );
  });

  it('writes runCode result to /tmp/<filename> via fs.writeFile', async () => {
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    const ctx = createStubContext();

    const mockTab = {
      page: {},
      modalStates: () => [],
      waitForCompletion: vi.fn(async (fn: () => Promise<void>) => fn()),
    };

    const response = new Response(ctx, 'browser_run_code', {});

    const tool = runCodeTools[0];
    await tool.handle(
        { ensureTab: vi.fn(async () => mockTab) } as any,
        { code: 'async (page) => { return "hello world"; }', filename: 'code-output.json' },
        response as any
    );

    expect(writeSpy).toHaveBeenCalledWith(
        path.join(os.tmpdir(), 'code-output.json'),
        expect.any(String),
        'utf-8'
    );
  });
});

// ---------------------------------------------------------------------------
// evaluate tool — filename branch (mocked response)
// ---------------------------------------------------------------------------

// Helper: create a mock context wrapping a mock tab for defineTabTool's ensureTab()
function createToolContext(mockTab: any) {
  return {
    ensureTab: vi.fn(async () => mockTab),
  } as any;
}

describe('evaluate tool filename output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes result to file when filename is provided', async () => {
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    const tool = evaluateTools[0];
    const mockTab = {
      page: { _evaluateFunction: vi.fn().mockResolvedValue('{"data":"test"}') },
      context: { config: {} },
      modalStates: () => [],
    };
    const mockResponse = {
      addFileResult: vi.fn().mockResolvedValue(undefined),
      addTextResult: vi.fn(),
      setSnapshotWaitFor: vi.fn(),
    };

    await tool.handle(createToolContext(mockTab), { function: '() => "test"', filename: 'result.json' }, mockResponse as any);

    expect(mockResponse.addFileResult).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: path.join(os.tmpdir(), 'result.json') }),
        expect.any(String)
    );
    expect(mockResponse.addTextResult).not.toHaveBeenCalled();
  });

  it('passes raw string through when result is string', async () => {
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    const tool = evaluateTools[0];
    const rawJson = '{"items":[1,2,3]}';
    const mockTab = {
      page: { _evaluateFunction: vi.fn().mockResolvedValue(rawJson) },
      context: { config: {} },
      modalStates: () => [],
    };
    const mockResponse = {
      addFileResult: vi.fn().mockResolvedValue(undefined),
      addTextResult: vi.fn(),
      setSnapshotWaitFor: vi.fn(),
    };

    await tool.handle(createToolContext(mockTab), { function: '() => "x"', filename: 'data.json' }, mockResponse as any);

    // Raw string passthrough — no double-encoding
    expect(mockResponse.addFileResult).toHaveBeenCalledWith(
        expect.anything(),
        rawJson
    );
  });

  it('returns inline when filename is not provided', async () => {
    const tool = evaluateTools[0];
    const mockTab = {
      page: { _evaluateFunction: vi.fn().mockResolvedValue({ a: 1 }) },
      context: { config: {} },
      modalStates: () => [],
    };
    const mockResponse = {
      addFileResult: vi.fn(),
      addTextResult: vi.fn(),
      setSnapshotWaitFor: vi.fn(),
    };

    await tool.handle(createToolContext(mockTab), { function: '() => ({a:1})' }, mockResponse as any);

    expect(mockResponse.addTextResult).toHaveBeenCalled();
    expect(mockResponse.addFileResult).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runCode tool — filename branch
// ---------------------------------------------------------------------------

describe('runCode tool filename output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes result to file when filename is provided', async () => {
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    const tool = runCodeTools[0];
    const mockTab = {
      page: {},
      modalStates: () => [],
      waitForCompletion: vi.fn(async (fn: () => Promise<void>) => fn()),
    };
    const mockResponse = {
      addCode: vi.fn(),
      addFileResult: vi.fn().mockResolvedValue(undefined),
      addTextResult: vi.fn(),
      setSnapshotWaitFor: vi.fn(),
    };

    await tool.handle(
        createToolContext(mockTab),
        { code: 'async (page) => { return "hello"; }', filename: 'output.json' },
        mockResponse as any
    );

    expect(mockResponse.addFileResult).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: path.join(os.tmpdir(), 'output.json') }),
        expect.any(String)
    );
    expect(mockResponse.addTextResult).not.toHaveBeenCalled();
  });

  it('returns inline when filename is not provided', async () => {
    const tool = runCodeTools[0];
    const mockTab = {
      page: {},
      modalStates: () => [],
      waitForCompletion: vi.fn(async (fn: () => Promise<void>) => fn()),
    };
    const mockResponse = {
      addCode: vi.fn(),
      addFileResult: vi.fn(),
      addTextResult: vi.fn(),
      setSnapshotWaitFor: vi.fn(),
    };

    await tool.handle(
        createToolContext(mockTab),
        { code: 'async (page) => { return "world"; }' },
        mockResponse as any
    );

    expect(mockResponse.addTextResult).toHaveBeenCalled();
    expect(mockResponse.addFileResult).not.toHaveBeenCalled();
  });
});
