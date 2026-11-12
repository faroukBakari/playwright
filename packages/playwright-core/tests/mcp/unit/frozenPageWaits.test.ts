import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RawKeyboardImpl, RawMouseImpl } from 'playwright-core/src/server/chromium/crInput';
import { FrameManager } from 'playwright-core/src/server/frames';
import { Keyboard, Mouse } from 'playwright-core/src/server/input';
import { ProgressController } from 'playwright-core/src/server/progress';
import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { Context } from 'playwright-core/src/tools/context';
import { remainingRequestBudget, runInRequestScope } from 'playwright-core/src/tools/requestScope';
import { Tab } from 'playwright-core/src/tools/tab';
import { browserTools } from 'playwright-core/src/tools/tools';
import { waitForCompletion } from 'playwright-core/src/tools/utils';

vi.mock('playwright-core/src/mcp/log', () => ({ serverLog: vi.fn(), logUnhandledError: vi.fn() }));

const never = new Promise<never>(() => {});
const replyTimeoutMs = 200;
const budgetMs = 1000;
const inputSentNote = 'Input sent, but the page did not acknowledge it within';

const reachedTheTarget = [
  `waiting for locator('aria-ref=e2')`,
  'locator resolved to <button>Stall</button>',
  'attempting click action',
  'waiting for element to be visible, enabled and stable',
  'element is visible, enabled and stable',
  'scrolling into view if needed',
  'done scrolling',
  'performing click action',
];
const replyAfterClickWithheld = [...reachedTheTarget, 'click action done', 'waiting for scheduled navigations to finish'];
const interceptedByAnotherElement = [...reachedTheTarget, '<div id="o"></div> intercepts pointer events', 'retrying click action', 'waiting 500ms'];

type Disposable = { dispose: () => Promise<void> };
const disposables: Disposable[] = [];

afterEach(async () => {
  try {
    for (const disposable of disposables.splice(0))
      await disposable.dispose();
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

function cdpClient(withheld: (method: string, type?: string) => boolean) {
  const sent: string[] = [];
  const send = (method: string, params?: { type?: string }) => {
    sent.push(`${method}:${params?.type}`);
    return withheld(method, params?.type) ? never : Promise.resolve({});
  };
  return { sent, send };
}

async function outcomeOf(run: Promise<unknown>) {
  return await run.then(value => value === undefined ? 'resolved' : `resolved: ${value}`, (error: Error) => error.name);
}

function playwrightTimeout(callLog: string[]) {
  const error = new Error(`locator.click: Timeout ${budgetMs}ms exceeded.\nCall log:\n\u001b[2m${callLog.map(line => `  - ${line}`).join('\n')}\u001b[22m\n`);
  error.name = 'TimeoutError';
  return error;
}

function textOf(result: { content?: Array<{ type: string, text?: string }> }) {
  return (result.content ?? []).map(part => part.type === 'text' ? part.text : '').join('\n');
}

function clickFixture(callLog: string[]) {
  const config = {
    codegen: 'none',
    snapshot: { mode: 'full' },
    timeouts: { budget: { default: budgetMs, navigate: budgetMs, runCode: budgetMs } },
  } as ConstructorParameters<typeof BrowserServerBackend>[0];
  const context = new Context({} as any, { config, cwd: os.tmpdir() });
  const rejectWithTimeout = () => Promise.reject(playwrightTimeout(callLog));
  const tab = {
    page: { url: () => 'about:blank' },
    modalStates: () => [],
    refLocator: async () => ({
      locator: { click: rejectWithTimeout, dblclick: rejectWithTimeout },
      resolved: `getByRole('button', { name: 'Stall' })`,
    }),
    actionTimeoutOptions: { timeout: budgetMs },
    waitForCompletion: async (callback: () => Promise<void>) => { await callback(); },
    captureSnapshot: async () => ({ ariaSnapshot: '- button "Stall"', modalStates: [], events: [] }),
    headerSnapshot: async () => ({
      title: 'Fixture', url: 'about:blank', current: true, changed: false,
      console: { total: 0, warnings: 0, errors: 0 },
    }),
    markSnapshotStale: () => {},
    dispose: async () => {},
  };
  Object.assign(context, { _tabs: [tab], _currentTab: tab });
  vi.spyOn(context, 'ensureTab').mockResolvedValue(tab as any);
  const clickTool = browserTools.find(tool => tool.schema.name === 'browser_click')!;
  const backend = new BrowserServerBackend(config, null, [clickTool]);
  vi.spyOn(backend as any, '_resolveContext').mockResolvedValue(context);
  disposables.push({
    dispose: async () => {
      await context.dispose();
      await backend.dispose();
    },
  });
  return async () => {
    const result = await backend.callTool('browser_click', { ref: 'e2', element: 'Stall' }, async () => {});
    const text = textOf(result);
    return { isError: !!result.isError, noted: text.includes(inputSentNote), text };
  };
}

describe('the waits that need the page to answer', () => {
  it('control: a withheld mouse-release reply holds the click until its timeout; move, press and release were sent', async () => {
    const click = async (withholdRelease: boolean) => {
      const client = cdpClient((_method, type) => withholdRelease && type === 'mouseReleased');
      const page = { keyboard: { _modifiers: () => new Set() } };
      const mouse = new Mouse(new RawMouseImpl({} as any, client as any, { isDragging: () => false } as any), page as any);
      const outcome = await outcomeOf(new ProgressController().run(progress => mouse.click(progress, 10, 10), replyTimeoutMs));
      return { outcome, sent: client.sent };
    };
    const allThreeSent = ['Input.dispatchMouseEvent:mouseMoved', 'Input.dispatchMouseEvent:mousePressed', 'Input.dispatchMouseEvent:mouseReleased'];

    expect(await click(false)).toEqual({ outcome: 'resolved', sent: allThreeSent });
    expect(await click(true)).toEqual({ outcome: 'TimeoutError', sent: allThreeSent });
  });

  it('control: a withheld key-down reply holds the key press until its timeout', async () => {
    const press = async (withholdKeyDown: boolean) => {
      const client = cdpClient((_method, type) => withholdKeyDown && type === 'keyDown');
      const drag = { isDragging: () => false, cancelDrag: async () => false };
      const keyboard = new Keyboard(new RawKeyboardImpl(client as any, false, drag as any), {} as any);
      const outcome = await outcomeOf(new ProgressController().run(progress => keyboard.press(progress, 'Enter'), replyTimeoutMs));
      return { outcome, sent: client.sent };
    };

    expect(await press(false)).toEqual({ outcome: 'resolved', sent: ['Input.dispatchKeyEvent:keyDown', 'Input.dispatchKeyEvent:keyUp'] });
    expect(await press(true)).toEqual({ outcome: 'TimeoutError', sent: ['Input.dispatchKeyEvent:keyDown'] });
  });

  it('control: a withheld post-click reply holds the action after its callback finished', async () => {
    const act = async (withholdReply: boolean) => {
      let callbackFinished = false;
      const frames = {
        _signalBarriers: new Set(),
        _page: { delegate: { inputActionEpilogue: () => withholdReply ? never : Promise.resolve() } },
      };
      const outcome = await outcomeOf(new ProgressController().run(progress => (FrameManager.prototype.waitForSignalsCreatedBy as any).call(frames, progress, true, async () => {
        callbackFinished = true;
        return 'done';
      }), replyTimeoutMs));
      return { outcome, callbackFinished };
    };

    expect(await act(false)).toEqual({ outcome: 'resolved: done', callbackFinished: true });
    expect(await act(true)).toEqual({ outcome: 'TimeoutError', callbackFinished: true });
  });

  it('regression: the post-action wait returns the action result by the deadline when the page does not answer', async () => {
    vi.useFakeTimers();
    const tab: Tab = Object.assign(Object.create(Tab.prototype), {
      page: { evaluate: () => never, _wrapApiCall: (fn: () => unknown) => fn(), on: () => {}, off: () => {} },
      context: {
        perfLog: { timeAsync: (_entry: unknown, fn: () => Promise<unknown>) => fn() },
        remainingBudget: remainingRequestBudget,
      },
      _modalStates: [],
    });
    let outcome: unknown = 'pending';
    const scope = { callId: 'call-1', tool: 'fixture_tool', deadline: Date.now() + budgetMs };

    void runInRequestScope(scope, () => waitForCompletion(tab, async () => 'action-result')).then(
        value => { outcome = value; },
        error => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(budgetMs);

    expect(outcome).toBe('action-result');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a click that timed out in the page', () => {
  it('regression: a click whose reply after the click is withheld returns success with the note', async () => {
    const click = clickFixture(replyAfterClickWithheld);

    const { text, ...outcome } = await click();

    expect(outcome, text).toEqual({ isError: false, noted: true });
  });

  it('control: a click that another element intercepted stays an error', async () => {
    const click = clickFixture(interceptedByAnotherElement);

    const { text, ...outcome } = await click();

    expect(outcome, text).toEqual({ isError: true, noted: false });
    expect(text).toContain('TimeoutError');
  });
});
