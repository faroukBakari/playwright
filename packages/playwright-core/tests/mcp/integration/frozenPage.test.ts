import fs from 'node:fs';
import os from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createInProcessPlaywright } from 'playwright-core/src/inProcessFactory';
import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { browserTools } from 'playwright-core/src/tools/tools';

const freezeMs = 2200;
const budgetMs = 1000;
const watchdogAllowanceMs = 500;
const testTimeoutMs = 20_000;
const inputSentNote = 'Input sent, but the page did not acknowledge it within';
const busy = `const end=performance.now()+${freezeMs};while(performance.now()<end){}`;

const pages = {
  clickFreezes: `<button onclick="document.title='clicked';${busy}">Stall</button>`,
  doubleClickFreezes: `<button ondblclick="document.title='double-clicked';${busy}">Stall</button>`,
  keyPressFreezes: `<body onkeydown="document.title='pressed';${busy}"><p>Press a key</p></body>`,
  idle: `<p>Idle</p>`,
  disabledButton: `<button disabled>Off</button>`,
  responsiveButton: `<button onclick="document.title='clicked'">Go</button>`,
};
const armFreezeThenReturn = `async (page) => { await page.evaluate(() => { setTimeout(() => { ${busy} }, 0); }); return 'armed'; }`;

const playwright = createInProcessPlaywright();
const chromiumInstalled = fs.existsSync(playwright.chromium.executablePath());
const suiteTitle = chromiumInstalled
  ? 'tool calls on a page whose main thread freezes'
  : `tool calls on a page whose main thread freezes (skipped: no Chromium at ${playwright.chromium.executablePath()})`;

type Browser = Awaited<ReturnType<typeof playwright.chromium.launch>>;
type Session = { backend: BrowserServerBackend, browserContext: Awaited<ReturnType<Browser['newContext']>> };

describe.skipIf(!chromiumInstalled)(suiteTitle, () => {
  let browser: Browser;
  const sessions: Session[] = [];

  beforeAll(async () => {
    browser = await playwright.chromium.launch({ headless: true });
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.backend.dispose();
      await session.browserContext.close();
    }
  });

  afterAll(async () => {
    await browser?.close();
  });

  function textOf(result: { content?: Array<{ type: string, text?: string }> }) {
    return (result.content ?? []).map(part => part.type === 'text' ? part.text : '').join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  }

  async function open(html: string) {
    const config = {
      codegen: 'none',
      snapshot: { mode: 'full' },
      timeouts: { budget: { default: 5000, navigate: 5000, runCode: 5000 } },
    } as ConstructorParameters<typeof BrowserServerBackend>[0];
    const browserContext = await browser.newContext();
    const backend = new BrowserServerBackend(config, browserContext as any, browserTools);
    sessions.push({ backend, browserContext });
    await backend.initialize({ cwd: os.tmpdir() } as any);

    const call = async (tool: string, args: Record<string, unknown>) => {
      const startedAt = performance.now();
      const result = await backend.callTool(tool, args, async () => {});
      const text = textOf(result);
      return { isError: !!result.isError, noted: text.includes(inputSentNote), text, elapsedMs: performance.now() - startedAt };
    };
    const opened = await call('browser_navigate', { url: `data:text/html,${encodeURIComponent(html)}` });
    const ref = /\[ref=(e\d+)\]/.exec(opened.text)?.[1];
    return { call, ref };
  }

  it('regression: a click whose handler freezes the page returns success with the note by its deadline', async () => {
    const page = await open(pages.clickFreezes);

    const { text, elapsedMs, ...outcome } = await page.call('browser_click', { ref: page.ref, element: 'Stall', timeout: budgetMs / 1000 });

    expect(outcome, text).toEqual({ isError: false, noted: true });
    expect(elapsedMs).toBeLessThan(budgetMs + watchdogAllowanceMs);
  }, testTimeoutMs);

  it('regression: a double click whose handler freezes the page returns success with the note', async () => {
    const page = await open(pages.doubleClickFreezes);

    const { text, elapsedMs, ...outcome } = await page.call('browser_click', { ref: page.ref, element: 'Stall', doubleClick: true, timeout: budgetMs / 1000 });

    expect(outcome, text).toEqual({ isError: false, noted: true });
    expect(elapsedMs).toBeLessThan(budgetMs + watchdogAllowanceMs);
  }, testTimeoutMs);

  it('regression: a key press whose handler freezes the page returns success with the note', async () => {
    const page = await open(pages.keyPressFreezes);

    const { text, elapsedMs, ...outcome } = await page.call('browser_press_key', { key: 'Enter', timeout: budgetMs / 1000 });

    expect(outcome, text).toEqual({ isError: false, noted: true });
    expect(elapsedMs).toBeLessThan(budgetMs + watchdogAllowanceMs);
  }, testTimeoutMs);

  it('regression: a page that freezes right after the action returned still gets a successful result', async () => {
    const page = await open(pages.idle);

    const { text, isError } = await page.call('browser_run_code', { code: armFreezeThenReturn, timeout: budgetMs / 1000 });

    expect({ isError, returned: text.includes('armed') }, text).toEqual({ isError: false, returned: true });
  }, testTimeoutMs);

  it('control: the frozen click was delivered', async () => {
    const page = await open(pages.clickFreezes);

    await page.call('browser_click', { ref: page.ref, element: 'Stall', timeout: budgetMs / 1000 });
    const afterTheFreeze = await page.call('browser_evaluate', { function: '() => document.title' });

    expect(afterTheFreeze.text).toContain('clicked');
  }, testTimeoutMs);

  it('control: a click on a disabled button stays an error', async () => {
    const page = await open(pages.disabledButton);

    const { text, isError, noted } = await page.call('browser_click', { ref: page.ref, element: 'Off', timeout: budgetMs / 1000 });

    expect({ isError, noted }, text).toEqual({ isError: true, noted: false });
    expect(text).toContain('TimeoutError');
  }, testTimeoutMs);

  it('control: a click on a responsive page returns its snapshot and no note', async () => {
    const page = await open(pages.responsiveButton);

    const { text, isError, noted } = await page.call('browser_click', { ref: page.ref, element: 'Go' });

    expect({ isError, noted }, text).toEqual({ isError: false, noted: false });
    expect(text).toContain('button "Go"');
  }, testTimeoutMs);
});
