import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { z } from 'playwright-core/src/mcpBundle';
import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { Context } from 'playwright-core/src/tools/context';
import { defineTool } from 'playwright-core/src/tools/tool';
import type { Response } from 'playwright-core/src/tools/response';

vi.mock('playwright-core/src/mcp/log', () => ({ serverLog: vi.fn(), logUnhandledError: vi.fn() }));

const budgetMs = 1000;
const safetyAllowanceMs = 500;

function deferred<T>(value: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, release: () => resolve(value) };
}

function createFixture(options: { stallHandler?: boolean; stallCapture?: boolean; stallHeaders?: boolean } = {}) {
  const config = {
    codegen: 'none',
    snapshot: { mode: 'full' },
    timeouts: { budget: { default: budgetMs, navigate: budgetMs, runCode: budgetMs } },
  } as ConstructorParameters<typeof BrowserServerBackend>[0];
  const context = new Context({} as any, { config, cwd: os.tmpdir() });
  const snapshot = { ariaSnapshot: '- button "Fixture"', modalStates: [], events: [] };
  const header = {
    title: 'Fixture', url: 'about:blank', current: true, changed: false,
    console: { total: 0, warnings: 0, errors: 0 },
  };
  const handlerGate = deferred(undefined);
  const captureGate = deferred(snapshot);
  const headerGate = deferred(header);
  const capture = vi.fn(() => options.stallCapture ? captureGate.promise : Promise.resolve(snapshot));
  const headers = vi.fn(() => options.stallHeaders ? headerGate.promise : Promise.resolve(header));
  const tab = {
    page: { url: () => 'about:blank' },
    captureSnapshot: capture,
    headerSnapshot: headers,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  Object.assign(context, { _tabs: [tab], _currentTab: tab });
  const handler = vi.fn(async (_context: Context, _params: unknown, response: Response) => {
    if (options.stallHandler)
      await handlerGate.promise;
    response.addTextResult('fixture-result');
    response.setIncludeSnapshot('full');
  });
  const tool = defineTool({
    capability: 'core',
    schema: {
      name: 'browser_deadline_fixture', title: 'Deadline fixture', description: 'Unit fixture',
      inputSchema: z.object({}), type: 'action',
    },
    handle: handler,
  });
  const backend = new BrowserServerBackend(config, null, [tool]);
  vi.spyOn(backend as any, '_resolveContext').mockResolvedValue(context);
  let outcome: Awaited<ReturnType<BrowserServerBackend['callTool']>> | undefined;
  let unexpectedError: unknown;
  let operation: Promise<void> | undefined;
  return {
    capture,
    headers,
    handler,
    handlerGate,
    get outcome() { return outcome; },
    run() {
      operation = backend.callTool(tool.schema.name, {}, async () => {}).then(
          result => { outcome = result; },
          error => { unexpectedError = error; },
      );
      return operation;
    },
    async cleanup() {
      handlerGate.release();
      captureGate.release();
      headerGate.release();
      await operation;
      await context.dispose();
      await backend.dispose();
      expect(unexpectedError).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    },
  };
}

let fixture: ReturnType<typeof createFixture> | undefined;

beforeEach(() => vi.useFakeTimers());

afterEach(async () => {
  try {
    await fixture?.cleanup();
  } finally {
    fixture = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

function expectTimeout(result: ReturnType<typeof createFixture>['outcome']) {
  expect(result, 'The complete response must settle within the original tool deadline allowance').toMatchObject({ isError: true });
  expect(result!.content).toEqual([
    { type: 'text', text: expect.stringContaining('timed out') },
  ]);
}

describe('complete response deadline unit boundary', () => {
  it('control: a completed response includes its snapshot and leaves no watchdog', async () => {
    fixture = createFixture();

    await fixture.run();

    expect(fixture.outcome?.isError).not.toBe(true);
    expect(fixture.outcome?.content).toEqual([
      { type: 'text', text: expect.stringContaining('- button "Fixture"') },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('control: the existing watchdog bounds a stalled handler', async () => {
    fixture = createFixture({ stallHandler: true });
    void fixture.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.handler).toHaveBeenCalledOnce();
    expect(fixture.capture).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(budgetMs + safetyAllowanceMs);

    expectTimeout(fixture.outcome);
  });

  it('control: a snapshot rejection preserves its application error', async () => {
    fixture = createFixture();
    fixture.capture.mockRejectedValueOnce(new Error('fixture snapshot rejected'));

    await fixture.run();

    expect(fixture.outcome).toMatchObject({ isError: true });
    expect(fixture.outcome?.content).toEqual([
      { type: 'text', text: expect.stringContaining('fixture snapshot rejected') },
    ]);
    expect(JSON.stringify(fixture.outcome)).not.toContain('timed out');
  });
});
