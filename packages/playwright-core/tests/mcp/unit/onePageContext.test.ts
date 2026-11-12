import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import attachTabTools from 'playwright-core/src/tools/attachTab';
import { Context } from 'playwright-core/src/tools/context';
import createTabTools from 'playwright-core/src/tools/createTab';
import type { AddressInfo } from 'node:net';

vi.mock('playwright-core/src/mcp/log', () => ({ serverLog: vi.fn(), logUnhandledError: vi.fn() }));

const [createTab] = createTabTools;
const [attachTab] = attachTabTools;

type RelayReply = { tabId: number; url?: string; targetInfo?: { targetId?: string; url?: string } };

function fakePage(targetId: string) {
  return Object.assign(new EventEmitter(), {
    url: () => `about:blank#${targetId}`,
    _connection: { toImpl: () => ({ delegate: { _targetId: targetId } }) },
  });
}

const cleanups: (() => Promise<void>)[] = [];

async function createFixture(options: { extensionMode: boolean }) {
  const browserContext = Object.assign(new EventEmitter(), { pages: () => [] });
  const config = { allowUnrestrictedFileAccess: true } as ConstructorParameters<typeof Context>[1]['config'];
  const context = new Context(browserContext as any, { config, cwd: os.tmpdir() });
  context.setClientId('session-a');

  // Stands in for the relay sideband: it answers a create or attach, and may announce pages first.
  let onRequest: () => RelayReply = () => {
    throw new Error('no relay reply scripted');
  };
  const relay = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(onRequest()));
    });
  });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  if (options.extensionMode)
    vi.spyOn(context, 'relayHttpUrl', 'get').mockReturnValue(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
  await context.ensureBrowserContext();

  const timers: ReturnType<typeof setTimeout>[] = [];
  cleanups.push(async () => {
    timers.forEach(clearTimeout);
    await context.dispose();
    await new Promise(resolve => relay.close(resolve));
  });

  const announce = (targetId: string) => browserContext.emit('page', fakePage(targetId));
  return {
    context,
    announce,
    announceLater: (targetId: string, delayMs: number) => timers.push(setTimeout(() => announce(targetId), delayMs)),
    relayAnswers: (reply: () => RelayReply) => onRequest = reply,
    currentTarget: () => (context.currentTab()?.page as any)?._connection.toImpl().delegate._targetId,
    run: (tool: typeof createTab | typeof attachTab, params: Record<string, unknown>) =>
      tool.handle(context, params as any, { setIncludeSnapshot: vi.fn(), addTextResult: vi.fn() } as any),
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup();
  vi.restoreAllMocks();
});

describe('one page per context', () => {
  it('regression: in extension mode a newly announced page becomes the current one', async () => {
    const f = await createFixture({ extensionMode: true });
    f.announce('target-1');
    f.announce('target-2');

    expect(f.currentTarget()).toBe('target-2');
  });

  it('control: outside extension mode the first page stays current', async () => {
    const f = await createFixture({ extensionMode: false });
    f.announce('target-1');
    f.announce('target-2');

    expect(f.currentTarget()).toBe('target-1');
  });

  it('regression: create returns when the page was announced before the relay answered', async () => {
    const f = await createFixture({ extensionMode: true });
    f.relayAnswers(() => {
      f.announce('target-7');
      return { tabId: 7, url: 'about:blank', targetInfo: { targetId: 'target-7' } };
    });

    await expect(f.run(createTab, {})).resolves.toBeUndefined();
    expect(f.currentTarget()).toBe('target-7');
  });

  it('regression: attach waits for the page of the tab the relay named', async () => {
    const f = await createFixture({ extensionMode: true });
    f.announce('target-1');
    f.relayAnswers(() => {
      f.announceLater('target-9', 20);
      f.announceLater('target-2', 300);
      return { tabId: 2, targetInfo: { targetId: 'target-2' } };
    });

    await f.run(attachTab, { tabId: 2 });

    expect(f.currentTarget()).toBe('target-2');
  });

  it('regression: attaching the tab the session is already on returns without a new page', async () => {
    const f = await createFixture({ extensionMode: true });
    f.announce('target-1');
    f.relayAnswers(() => ({ tabId: 1, targetInfo: { targetId: 'target-1' } }));

    await expect(f.run(attachTab, { tabId: 1 })).resolves.toBeUndefined();
    expect(f.context.tabs()).toHaveLength(1);
  });

  it.each([
    ['create', createTab, {}],
    ['attach', attachTab, { tabId: 5 }],
  ] as const)('regression: %s fails when the relay reply names no target', async (_name, tool, params) => {
    const f = await createFixture({ extensionMode: true });
    f.relayAnswers(() => {
      f.announce('target-5');
      return { tabId: 5 };
    });

    await expect(f.run(tool, params)).rejects.toThrow('Relay reply has no target id');
  });
});
