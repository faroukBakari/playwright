/**
 * Unit tests for browser_file_upload hidden-input (ref) mode.
 *
 * Tests cover the four runtime branches in the handler:
 *   A. Modal-only flow (regression — existing callers must be unaffected)
 *   B. Ref-only flow (new) — direct setInputFiles on hidden <input type="file">
 *   C. Both modal + ref → ambiguous rejection
 *   D. Neither modal nor ref → "no file chooser" rejection
 *
 * Also covers: wrong element type rejection (ref resolves to non-file-input).
 *
 * Mocking strategy:
 *   - Top-level vi.mock for 'fs' and 'child_process' (hoisted by vitest)
 *   - The outer Tool.handle is called with a Context stub that returns a Tab stub
 *     via ensureTab(). This matches the comboTools.test.ts pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mutable mock state — shared with vi.mock factories (must be top-level)
// ---------------------------------------------------------------------------

const mockState = {
  isWSL: false,
  statResult: 'file' as 'file' | 'enoent',
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
        return { isDirectory: () => false };
      },
      readFile: async (_p: string) => Buffer.from('fake-file-content'),
    },
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (cmd: string, _args: string[], _opts?: any) => {
      if (cmd === 'wslpath')
        throw Object.assign(new Error('spawn wslpath ENOENT'), { code: 'ENOENT' });
      return actual.execFileSync(cmd, _args as any, _opts as any);
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import filesModule from 'playwright-core/src/tools/files';
import { _resetWSLCache } from 'playwright-core/src/tools/files';
import { Response } from 'playwright-core/src/tools/response';

const filesTools: any[] = (filesModule as any).default ?? filesModule;
const uploadFileTool = filesTools.find((t: any) => t.schema?.name === 'browser_file_upload');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock locator for a given element type evaluation result. */
function makeLocator(elementType: { tag: string; type: string | null }) {
  return {
    evaluate: vi.fn(async (_fn: any) => elementType),
    setInputFiles: vi.fn(),
  };
}

/** Build a file chooser modal state stub. */
function makeFileChooserModal() {
  return {
    type: 'fileChooser' as const,
    description: 'File chooser',
    fileChooser: { setFiles: vi.fn() },
    clearedBy: { tool: 'browser_file_upload', skill: '' },
  };
}

/**
 * Build Context + Tab stubs and a Response, then call the tool's outer handle.
 * This is the same pattern as comboTools.test.ts — the outer handle calls
 * context.ensureTab(), checks modal state, then delegates to the inner handler.
 */
function createStubs(tabOverrides: Partial<{
  modalStates: any[];
  refLocatorResult: { locator: any; resolved: string };
}> = {}) {
  const { modalStates = [], refLocatorResult } = tabOverrides;

  const tab = {
    modalStates: () => modalStates,
    clearModalState: vi.fn(),
    waitForCompletion: vi.fn(async (cb: () => Promise<void>) => {
      await cb();
    }),
    refLocator: vi.fn(async (_params: any) => {
      if (!refLocatorResult)
        throw new Error('refLocator called but no result configured');
      return refLocatorResult;
    }),
  };

  const context = {
    ensureTab: vi.fn().mockResolvedValue(tab),
    options: { cwd: '/tmp' },
    config: { snapshot: { mode: 'incremental' } },
    tabs: () => [],
  };

  const response = new Response(context as any, 'browser_file_upload', {});

  return { context, tab, response };
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState.isWSL = false;
  mockState.statResult = 'file';
  _resetWSLCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

describe('browser_file_upload schema additions', () => {
  it('tool exists in files module exports', () => {
    expect(uploadFileTool).toBeDefined();
  });

  it('ref is optional in schema', () => {
    const shape = uploadFileTool.schema.inputSchema.shape;
    expect(shape.ref).toBeDefined();
    expect(shape.ref.isOptional()).toBe(true);
  });

  it('element is optional in schema', () => {
    const shape = uploadFileTool.schema.inputSchema.shape;
    expect(shape.element).toBeDefined();
    expect(shape.element.isOptional()).toBe(true);
  });

  it('clearsModalStateOptional is set on the tool', () => {
    expect(uploadFileTool.clearsModalStateOptional).toBe(true);
  });

  it('clearsModalState is still set to fileChooser', () => {
    expect(uploadFileTool.clearsModalState).toBe('fileChooser');
  });

  it('description mentions both modes', () => {
    const desc = uploadFileTool.schema.description;
    expect(desc).toContain('ref');
    expect(desc).toContain('file chooser');
  });
});

// ---------------------------------------------------------------------------
// Branch A: modal-only flow — regression guard
// ---------------------------------------------------------------------------

describe('Branch A: modal-only flow (regression)', () => {
  it('calls fileChooser.setFiles with resolved paths when modal present and no ref', async () => {
    const modal = makeFileChooserModal();
    const { context, tab, response } = createStubs({ modalStates: [modal] });

    await uploadFileTool.handle(context, { paths: ['/tmp/file.pdf'] }, response);

    expect(modal.fileChooser.setFiles).toHaveBeenCalledWith(['/tmp/file.pdf']);
    expect(tab.clearModalState).toHaveBeenCalledWith(modal);
    // refLocator must NOT be called in modal-only flow
    expect(tab.refLocator).not.toHaveBeenCalled();
  });

  it('cancels file chooser when paths omitted in modal mode', async () => {
    const modal = makeFileChooserModal();
    const { context, tab, response } = createStubs({ modalStates: [modal] });

    await uploadFileTool.handle(context, {}, response);

    expect(tab.clearModalState).toHaveBeenCalledWith(modal);
    expect(modal.fileChooser.setFiles).not.toHaveBeenCalled();
    expect(tab.refLocator).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Branch B: ref-only flow (new)
// ---------------------------------------------------------------------------

describe('Branch B: ref-only flow — hidden file input', () => {
  it('calls locator.setInputFiles with resolved paths for a valid <input type="file">', async () => {
    const locator = makeLocator({ tag: 'input', type: 'file' });
    const { context, tab, response } = createStubs({
      modalStates: [],
      refLocatorResult: { locator, resolved: 'locator("input[type=file]")' },
    });

    await uploadFileTool.handle(context, { paths: ['/tmp/doc.pdf'], ref: 'e1', element: 'file input' }, response);

    expect(tab.refLocator).toHaveBeenCalledWith({ ref: 'e1', element: 'file input' });
    expect(locator.setInputFiles).toHaveBeenCalledWith(['/tmp/doc.pdf']);
    // fileChooser was not involved
    expect(tab.clearModalState).not.toHaveBeenCalled();
  });

  it('throws when ref resolves to a non-file-input element (button)', async () => {
    const locator = makeLocator({ tag: 'button', type: null });
    const { context, response } = createStubs({
      modalStates: [],
      refLocatorResult: { locator, resolved: 'locator("button")' },
    });

    await expect(
        uploadFileTool.handle(context, { paths: ['/tmp/doc.pdf'], ref: 'e2' }, response)
    ).rejects.toThrow('is not a file input');

    expect(locator.setInputFiles).not.toHaveBeenCalled();
  });

  it('throws when ref resolves to <input type="text">', async () => {
    const locator = makeLocator({ tag: 'input', type: 'text' });
    const { context, response } = createStubs({
      modalStates: [],
      refLocatorResult: { locator, resolved: 'locator("input[type=text]")' },
    });

    await expect(
        uploadFileTool.handle(context, { paths: ['/tmp/doc.pdf'], ref: 'e3' }, response)
    ).rejects.toThrow('is not a file input');
  });

  it('throws when paths is omitted with ref', async () => {
    const locator = makeLocator({ tag: 'input', type: 'file' });
    const { context, response } = createStubs({
      modalStates: [],
      refLocatorResult: { locator, resolved: 'locator("input[type=file]")' },
    });

    await expect(
        uploadFileTool.handle(context, { ref: 'e4' }, response)
    ).rejects.toThrow('`paths` is required');

    expect(locator.setInputFiles).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Branch C: both modal + ref — ambiguous rejection
// ---------------------------------------------------------------------------

describe('Branch C: ambiguous (modal + ref)', () => {
  it('throws when file chooser modal is open and ref is also provided', async () => {
    const modal = makeFileChooserModal();
    const locator = makeLocator({ tag: 'input', type: 'file' });
    const { context, tab, response } = createStubs({
      modalStates: [modal],
      refLocatorResult: { locator, resolved: 'locator("input[type=file]")' },
    });

    await expect(
        uploadFileTool.handle(context, { paths: ['/tmp/doc.pdf'], ref: 'e5' }, response)
    ).rejects.toThrow('Ambiguous');

    expect(modal.fileChooser.setFiles).not.toHaveBeenCalled();
    expect(locator.setInputFiles).not.toHaveBeenCalled();
    expect(tab.refLocator).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Branch D: neither modal nor ref
// ---------------------------------------------------------------------------

describe('Branch D: neither modal nor ref', () => {
  it('throws the "no file chooser" error when no modal and no ref', async () => {
    const { context, response } = createStubs({ modalStates: [] });

    await expect(
        uploadFileTool.handle(context, { paths: ['/tmp/doc.pdf'] }, response)
    ).rejects.toThrow('No file chooser visible');
  });
});
