import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { z } from 'playwright-core/src/mcpBundle';
import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { Context } from 'playwright-core/src/tools/context';
import { Response as ResponseClass } from 'playwright-core/src/tools/response';
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
  const markStale = vi.fn();
  const tab = {
    page: { url: () => 'about:blank' },
    captureSnapshot: capture,
    headerSnapshot: headers,
    markSnapshotStale: markStale,
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
    captureGate,
    markStale,
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

function expectSuccessWithoutSnapshot(result: ReturnType<typeof createFixture>['outcome'], reason: string) {
  expect(result, 'The response must be returned by the call deadline').toBeDefined();
  expect(result!.isError).not.toBe(true);
  const text = result!.content.map(part => part.type === 'text' ? part.text : '').join('\n');
  expect(text).toContain('fixture-result');
  expect(text).toContain(`snapshot unavailable: ${reason}`);
  expect(text).not.toContain('### Snapshot');
  expect(text).not.toContain('### Page');
}

describe('complete response deadline unit boundary', () => {
  it('regression: a stalled snapshot capture returns the result with a note by the deadline', async () => {
    fixture = createFixture({ stallCapture: true });
    void fixture.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.capture).toHaveBeenCalledOnce();
    expect(fixture.headers).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(budgetMs);

    expectSuccessWithoutSnapshot(fixture.outcome, 'not captured before the call deadline');
    expect(fixture.markStale).toHaveBeenCalledTimes(1);
    fixture.captureGate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.markStale, 'a capture that finishes late must not leave a diff baseline the caller never saw').toHaveBeenCalledTimes(2);
  });

  it('regression: stalled tab headers return the result with a note by the deadline', async () => {
    fixture = createFixture({ stallHeaders: true });
    void fixture.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.capture).toHaveBeenCalledOnce();
    expect(fixture.headers).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(budgetMs);

    expectSuccessWithoutSnapshot(fixture.outcome, 'not captured before the call deadline');
  });

  it('regression: handler and snapshot share one deadline', async () => {
    fixture = createFixture({ stallHandler: true, stallCapture: true });
    void fixture.run();
    await vi.advanceTimersByTimeAsync(600);
    expect(fixture.capture).not.toHaveBeenCalled();
    fixture.handlerGate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.capture).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(budgetMs - 600);

    expectSuccessWithoutSnapshot(fixture.outcome, 'not captured before the call deadline');
  });

  it('regression: a rejected snapshot returns the result with the rejection as a note', async () => {
    fixture = createFixture();
    fixture.capture.mockRejectedValueOnce(new Error('fixture snapshot rejected'));

    await fixture.run();

    expectSuccessWithoutSnapshot(fixture.outcome, 'fixture snapshot rejected');
  });

  it('regression: a stalled handler returns the stop text', async () => {
    fixture = createFixture({ stallHandler: true });
    void fixture.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.handler).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(budgetMs + safetyAllowanceMs);

    expectTimeout(fixture.outcome);
    expect(fixture.outcome!.content).toEqual([
      { type: 'text', text: expect.stringContaining(`timed out after ${budgetMs}ms. The call was stopped and the page is being re-attached; page JavaScript that already started may still take effect; element refs from earlier snapshots are invalid.`) },
    ]);
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it('a response still unbuilt after the handler returned reports the action as completed', async () => {
    fixture = createFixture();
    vi.spyOn(ResponseClass.prototype, 'serialize').mockReturnValue(new Promise(() => {}));
    void fixture.run();

    await vi.advanceTimersByTimeAsync(budgetMs + safetyAllowanceMs);

    expect(fixture.handler).toHaveBeenCalledOnce();
    expect(fixture.outcome).toMatchObject({ isError: true });
    expect(fixture.outcome!.content).toEqual([
      { type: 'text', text: expect.stringContaining('completed its action, but its response could not be built') },
    ]);
    expect(JSON.stringify(fixture.outcome)).not.toContain('The call was stopped');
  });

  it('control: a completed response includes its snapshot and leaves no watchdog', async () => {
    fixture = createFixture();

    await fixture.run();

    expect(fixture.outcome?.isError).not.toBe(true);
    expect(fixture.outcome?.content).toEqual([
      { type: 'text', text: expect.stringContaining('- button "Fixture"') },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('control: a handler error stays an error', async () => {
    fixture = createFixture();
    fixture.handler.mockRejectedValueOnce(new Error('fixture handler rejected'));

    await fixture.run();

    expect(fixture.outcome).toMatchObject({ isError: true });
    expect(fixture.outcome?.content).toEqual([
      { type: 'text', text: expect.stringContaining('fixture handler rejected') },
    ]);
    expect(JSON.stringify(fixture.outcome)).not.toContain('timed out');
  });
});
