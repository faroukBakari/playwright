import http from 'node:http';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { z } from 'playwright-core/src/mcpBundle';
import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { Context } from 'playwright-core/src/tools/context';
import { defineTool } from 'playwright-core/src/tools/tool';
import type { AddressInfo } from 'node:net';

vi.mock('playwright-core/src/mcp/log', () => ({ serverLog: vi.fn(), logUnhandledError: vi.fn() }));

type Outcome = Awaited<ReturnType<BrowserServerBackend['callTool']>>;

const SESSION = 'session-a';
const STALL_TIMEOUT_SEC = 0.1;

function stubTab(label: string) {
  return { label, page: { url: () => `about:blank#${label}` }, dispose: vi.fn().mockResolvedValue(undefined) };
}

async function createFixture(options: { withTab: boolean; recycleFails?: boolean; holdRecycle?: boolean }) {
  const config = {
    codegen: 'none',
    snapshot: { mode: 'none' },
    timeouts: { budget: { default: 2000, navigate: 2000, runCode: 2000 } },
  } as ConstructorParameters<typeof BrowserServerBackend>[0];
  const context = new Context({} as any, { config, cwd: os.tmpdir() });
  context.setClientId(SESSION);
  const setTabs = (tabs: ReturnType<typeof stubTab>[]) => Object.assign(context, { _tabs: tabs, _currentTab: tabs[0] });
  setTabs(options.withTab ? [stubTab('before-stop')] : []);

  const events: string[] = [];
  const recycleBodies: unknown[] = [];
  let releaseRecycle!: () => void;
  const recycleGate = new Promise<void>(resolve => releaseRecycle = resolve);
  if (!options.holdRecycle)
    releaseRecycle();
  // Stands in for the relay sideband: it owns the debugger attachment the tools layer asks to recycle.
  const relay = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      if (req.url !== '/tabs/recycle' || req.method !== 'POST') {
        res.statusCode = 404;
        res.end();
        return;
      }
      events.push('recycle-posted');
      recycleBodies.push(JSON.parse(body));
      await recycleGate;
      res.setHeader('Content-Type', 'application/json');
      if (options.recycleFails) {
        setTabs([]);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'fixture attach failure' }));
        return;
      }
      setTabs([stubTab('after-stop')]);
      events.push('recycle-answered');
      res.end(JSON.stringify({ tabId: 10 }));
    });
  });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  vi.spyOn(context, 'relayHttpUrl', 'get').mockReturnValue(relayUrl);

  let releaseStall!: () => void;
  const stallGate = new Promise<void>(resolve => releaseStall = resolve);
  const stall = defineTool({
    capability: 'core',
    noTabRequired: true,
    schema: {
      name: 'fixture_stall', title: 'Stalled fixture', description: 'Never returns by itself',
      inputSchema: z.object({}), type: 'action',
    },
    handle: async () => {
      await stallGate;
    },
  });
  const echo = defineTool({
    capability: 'core',
    schema: {
      name: 'fixture_echo', title: 'Echo fixture', description: 'Reports the tab it ran on',
      inputSchema: z.object({}), type: 'action',
    },
    handle: async (toolContext, _params, response) => {
      events.push('echo-started');
      response.addTextResult(`echo on ${(toolContext.currentTab() as any).label}`);
      response.setIncludeSnapshot('none');
    },
  });
  const backend = new BrowserServerBackend(config, null, [stall, echo]);
  vi.spyOn(backend as any, '_resolveContext').mockResolvedValue(context);
  const pending: Promise<unknown>[] = [];
  const call = (tool: string, args: Record<string, unknown> = {}) => {
    const tracked: { outcome?: Outcome; done: Promise<void> } = { done: Promise.resolve() };
    tracked.done = backend.callTool(tool, args, async () => {}, SESSION).then(result => {
      events.push(`${tool}-result`);
      tracked.outcome = result;
    });
    pending.push(tracked.done);
    return tracked;
  };
  return {
    call,
    events,
    recycleBodies,
    releaseRecycle,
    async cleanup() {
      releaseStall();
      releaseRecycle();
      await Promise.all(pending);
      await backend.dispose();
      await context.dispose();
      await new Promise(resolve => relay.close(resolve));
    },
  };
}

function textOf(outcome: Outcome | undefined): string {
  return (outcome?.content ?? []).map(part => part.type === 'text' ? part.text : '').join('\n');
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;

afterEach(async () => {
  try {
    await fixture?.cleanup();
  } finally {
    fixture = undefined;
    vi.restoreAllMocks();
  }
});

describe('hard stop of a call that outlives its deadline', () => {
  it('regression: a stalled handler with a tab asks the relay to recycle the tab after the timeout result', async () => {
    fixture = await createFixture({ withTab: true });

    const stalled = fixture.call('fixture_stall', { timeout: STALL_TIMEOUT_SEC });
    await stalled.done;

    expect(textOf(stalled.outcome)).toContain('The call was stopped and the page is being re-attached');
    await vi.waitFor(() => expect(fixture!.recycleBodies).toEqual([{ sessionId: SESSION }]), { timeout: 1000 });
    expect(fixture.events.slice(0, 2)).toEqual(['fixture_stall-result', 'recycle-posted']);
  });

  it('regression: the next call of the session waits for the recycle and runs on the re-attached page', async () => {
    fixture = await createFixture({ withTab: true, holdRecycle: true });
    await fixture.call('fixture_stall', { timeout: STALL_TIMEOUT_SEC }).done;

    const next = fixture.call('fixture_echo');
    await settle(200);
    expect(fixture.events).toEqual(['fixture_stall-result', 'recycle-posted']);

    fixture.releaseRecycle();
    await next.done;

    expect(textOf(next.outcome)).toContain('echo on after-stop');
    expect(fixture.events).toEqual(['fixture_stall-result', 'recycle-posted', 'recycle-answered', 'echo-started', 'fixture_echo-result']);
  });

  it('regression: a failed recycle is reported once, by the next call that finds no tab', async () => {
    fixture = await createFixture({ withTab: true, recycleFails: true });
    await fixture.call('fixture_stall', { timeout: STALL_TIMEOUT_SEC }).done;

    const next = fixture.call('fixture_echo');
    await next.done;
    const later = fixture.call('fixture_echo');
    await later.done;

    expect(next.outcome).toMatchObject({ isError: true });
    expect(textOf(next.outcome)).toContain('No active tab');
    expect(textOf(next.outcome)).toContain('fixture attach failure');
    expect(textOf(later.outcome)).toContain('No active tab');
    expect(textOf(later.outcome)).not.toContain('fixture attach failure');
  });

  it('control: a stalled handler without a tab asks for nothing', async () => {
    fixture = await createFixture({ withTab: false });

    const stalled = fixture.call('fixture_stall', { timeout: STALL_TIMEOUT_SEC });
    await stalled.done;
    await settle(200);

    expect(textOf(stalled.outcome)).toContain('timed out after 100ms');
    expect(fixture.recycleBodies).toEqual([]);
  });
});
