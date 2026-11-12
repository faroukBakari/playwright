import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CDPCommandRouter } from 'playwright-core/src/mcp/cdpCommandRouter';
import { CDPRelayServer } from 'playwright-core/src/mcp/cdpRelay';
import { ExtensionConnection } from 'playwright-core/src/mcp/extensionConnection';
import { installRelayHTTPEndpoints } from 'playwright-core/src/mcp/relayHttpEndpoints';
import { SessionBinding } from 'playwright-core/src/mcp/sessionBinding';
import { SessionGraceManager } from 'playwright-core/src/mcp/sessionGrace';
import type { AddressInfo } from 'node:net';
import type { CDPResponse, ClientSession } from 'playwright-core/src/mcp/cdpRelayTypes';

vi.mock('playwright-core/src/mcp/log', () => ({ serverLog: vi.fn(), logUnhandledError: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

function createFixture() {
  const target = (tabId: number) => ({ targetId: `target-${tabId}`, type: 'page', url: `https://fixture.invalid/${tabId}`, title: `Tab ${tabId}` });
  const events: CDPResponse[] = [];
  const unrelatedEvents: CDPResponse[] = [];
  const bindingAtSend: Array<{ tabId: number | null; targetId: string | undefined }> = [];
  const owner: ClientSession = {
    sessionId: 'owner',
    cdpSessionId: 'cdp-owner',
    targetInfo: null,
    tabId: null,
    _connectionId: 1,
    isOpen: () => true,
    send: message => {
      events.push(message);
      bindingAtSend.push({ tabId: owner.tabId, targetId: owner.targetInfo?.targetId });
    },
    sendRaw: vi.fn(),
    close: vi.fn(),
  };
  const unrelated: ClientSession = {
    ...owner,
    sessionId: 'unrelated',
    cdpSessionId: 'cdp-unrelated',
    tabId: 30,
    targetInfo: target(30),
    send: message => unrelatedEvents.push(message),
  };
  const clients = new Map([[owner.sessionId, owner], [unrelated.sessionId, unrelated]]);
  const send = vi.fn(async (method: string, params: { tabId?: number }) => {
    const tabId = method === 'createTab' ? 20 : params.tabId!;
    return { tabId, targetInfo: target(tabId) };
  });
  const extension = { send };
  const sendToClient = (session: ClientSession, message: CDPResponse) => session.send(message);
  // Socket construction/delivery is outside this unit's target-transition contract.
  const relay: CDPRelayServer = Object.create(CDPRelayServer.prototype);
  const binding = new SessionBinding({ sendToClient });
  const router = new CDPCommandRouter({
    getClient: id => clients.get(id),
    getExtensionConnection: () => extension as any,
    getExtensionMismatch: () => relay['_extensionMismatch'],
    getState: () => 'connected',
    getExtensionCommandTimeout: () => 100,
    sendToClient,
    bufferEvent: vi.fn(),
    binding,
  });
  Object.assign(relay, {
    _clients: clients,
    _extensionConnection: extension,
    _extensionMismatch: null,
    _extensionCommandTimeout: 100,
    _maxConcurrentClients: 10,
    _dormantSessions: new Map(),
    _sessionGrace: new SessionGraceManager(0),
    _stateMachine: { state: 'connected', bufferEvent: vi.fn() },
    _sendToClient: sendToClient,
    _binding: binding,
    _commandRouter: router,
  });
  const fromExtension = (method: string, params: object) => (relay as any)._handleExtensionMessage(method, params);
  const command = (id: number, method: string) => router.handleMessage({ id, sessionId: 'cdp-owner', method, params: {} }, 'owner');
  return { relay, owner, unrelated, events, unrelatedEvents, bindingAtSend, send, target, fromExtension, command };
}

const reloadMessage = 'The browser extension is older than the server: reload it in chrome://extensions, then retry.';

describe('relay target lifecycle unit boundary', () => {
  it('regression: replacement detaches the old target before attaching the new target', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;
    f.bindingAtSend.length = 0;

    await f.relay.createTab('owner', 'https://fixture.invalid/20');

    expect(f.events).toMatchObject([
      { method: 'Target.detachedFromTarget', params: { sessionId: 'cdp-owner', targetId: 'target-10' } },
      { method: 'Target.attachedToTarget', params: { targetInfo: { targetId: 'target-20' } } },
    ]);
    expect(f.bindingAtSend[0]).toEqual({ tabId: 10, targetId: 'target-10' });
    expect(f.owner.tabId).toBe(20);
    expect(f.owner.targetInfo.targetId).toBe('target-20');
    expect(f.unrelatedEvents).toEqual([]);
    expect(f.unrelated.tabId).toBe(30);
  });

  it('regression: recycle detaches then re-attaches the same tab', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;
    f.send.mockClear();
    const reply = f.send.getMockImplementation()!;
    const bindingAtCommand: Array<{ method: string; tabId: number | null }> = [];
    f.send.mockImplementation(async (method, params) => {
      bindingAtCommand.push({ method, tabId: f.owner.tabId });
      return reply(method, params);
    });

    await f.relay.recycleTab('owner');

    expect(f.send.mock.calls.map(([method, params]) => ({ method, params }))).toEqual([
      { method: 'detachTab', params: { sessionId: 'owner' } },
      { method: 'attachToTab', params: { sessionId: 'owner', tabId: 10 } },
    ]);
    expect(bindingAtCommand).toEqual([
      { method: 'detachTab', tabId: null },
      { method: 'attachToTab', tabId: null },
    ]);
    expect(f.events).toMatchObject([
      { method: 'Target.detachedFromTarget', params: { sessionId: 'cdp-owner', targetId: 'target-10' } },
      { method: 'Target.attachedToTarget', params: { sessionId: 'cdp-owner', targetInfo: { targetId: 'target-10' } } },
    ]);
    expect(f.owner.tabId).toBe(10);
    expect(f.owner.targetInfo.targetId).toBe('target-10');
    expect(f.unrelatedEvents).toEqual([]);
  });

  it('regression: recycle leaves the session unbound when the re-attach fails', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;
    const reply = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params) => {
      if (method === 'attachToTab')
        throw new Error('fixture attach failure');
      return reply(method, params);
    });

    await expect(f.relay.recycleTab('owner')).rejects.toThrow('fixture attach failure');

    expect(f.events).toMatchObject([
      { method: 'Target.detachedFromTarget', params: { sessionId: 'cdp-owner', targetId: 'target-10' } },
    ]);
    expect(f.owner.tabId).toBeNull();
    expect(f.owner.targetInfo).toBeNull();
    expect(f.unrelated.tabId).toBe(30);
  });

  it('regression: recycle without a bound tab is rejected and sends nothing', async () => {
    const f = createFixture();

    await expect(f.relay.recycleTab('owner')).rejects.toThrow('has no tab to recycle');

    expect(f.send).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });

  it('control: initial creation announces one target without a detach', async () => {
    const f = createFixture();

    await f.relay.createTab('owner', 'https://fixture.invalid/20');

    expect(f.events).toMatchObject([
      { method: 'Target.attachedToTarget', params: { sessionId: 'cdp-owner', targetInfo: { targetId: 'target-20' } } },
    ]);
    expect(f.owner.tabId).toBe(20);
    expect(f.unrelatedEvents).toEqual([]);
  });

  it('control: different-tab attach retires the previous target', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;

    await f.relay.attachTab('owner', 20);

    expect(f.events).toMatchObject([
      { method: 'Target.detachedFromTarget', params: { sessionId: 'cdp-owner', targetId: 'target-10' } },
      { method: 'Target.attachedToTarget', params: { targetInfo: { targetId: 'target-20' } } },
    ]);
    expect(f.owner.tabId).toBe(20);
    expect(f.unrelatedEvents).toEqual([]);
  });

  it('control: failed extension creation preserves the previous binding', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;
    f.send.mockRejectedValueOnce(new Error('fixture creation rejected'));

    await expect(f.relay.createTab('owner')).rejects.toThrow('fixture creation rejected');

    expect(f.events).toEqual([]);
    expect(f.owner.tabId).toBe(10);
    expect(f.owner.targetInfo).toEqual(f.target(10));
  });

  it('control: a reported detach for an unknown session or for a tab the session already left changes nothing', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;

    f.fromExtension('bindingDetached', { sessionId: 'unknown', tabId: 99, reason: 'closed' });
    f.fromExtension('bindingDetached', { sessionId: 'unknown', tabId: 10, reason: 'closed' });
    f.fromExtension('bindingDetached', { sessionId: 'owner', tabId: 99, reason: 'moved' });

    expect(f.events).toEqual([]);
    expect(f.unrelatedEvents).toEqual([]);
    expect(f.owner.tabId).toBe(10);
    expect(f.owner.targetInfo).toEqual(f.target(10));
  });

  it('regression: same-tab attach does not announce a duplicate target', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;

    await f.relay.attachTab('owner', 10);

    expect(f.events).toEqual([]);
    expect(f.owner.tabId).toBe(10);
    expect(f.owner.targetInfo.targetId).toBe('target-10');
    expect(f.unrelatedEvents).toEqual([]);
  });

  it.each(['closed', 'lost', 'moved'])('regression: a reported detach (%s) notifies the owning client before clearing its target', async reason => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;
    f.bindingAtSend.length = 0;

    f.fromExtension('bindingDetached', { sessionId: 'owner', tabId: 10, reason });

    expect(f.events).toMatchObject([
      { method: 'Target.detachedFromTarget', params: { sessionId: 'cdp-owner', targetId: 'target-10' } },
    ]);
    expect(f.bindingAtSend).toEqual([{ tabId: 10, targetId: 'target-10' }]);
    expect(f.owner.tabId).toBeNull();
    expect(f.owner.targetInfo).toBeNull();
    expect(f.owner.cdpSessionId).toBe('cdp-owner');
    expect(f.unrelatedEvents).toEqual([]);
  });

  it('regression: a bump reported during an attach retires the previous owner and binds the new one', async () => {
    const f = createFixture();
    f.send.mockImplementationOnce(async () => {
      f.fromExtension('bindingDetached', { sessionId: 'unrelated', tabId: 30, reason: 'bumped' });
      return { tabId: 30, targetInfo: f.target(30) };
    });

    await f.relay.attachTab('owner', 30);

    expect(f.unrelatedEvents).toMatchObject([
      { method: 'Target.detachedFromTarget', params: { sessionId: 'cdp-unrelated', targetId: 'target-30' } },
    ]);
    expect(f.unrelated.tabId).toBeNull();
    expect(f.events).toMatchObject([
      { method: 'Target.attachedToTarget', params: { sessionId: 'cdp-owner', targetInfo: { targetId: 'target-30' } } },
    ]);
    expect(f.owner.tabId).toBe(30);
  });
});

describe('tab-addressed traffic', () => {
  it('regression: an event stamped with a tab the session left is dropped', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;

    f.fromExtension('forwardCDPEvent', { sessionId: 'owner', tabId: 20, method: 'Page.loadEventFired', params: {} });
    f.fromExtension('forwardCDPEvent', { sessionId: 'unknown', tabId: 10, method: 'Page.loadEventFired', params: {} });

    expect(f.events).toEqual([]);
    expect(f.unrelatedEvents).toEqual([]);
  });

  it('control: an event stamped with the bound tab reaches the session and refreshes its URL', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;

    f.fromExtension('forwardCDPEvent', { sessionId: 'owner', tabId: 10, method: 'Page.frameNavigated', params: { frame: { url: 'https://fixture.invalid/next' } } });

    expect(f.events).toEqual([{ sessionId: 'cdp-owner', method: 'Page.frameNavigated', params: { frame: { url: 'https://fixture.invalid/next' } } }]);
    expect(f.owner.targetInfo.url).toBe('https://fixture.invalid/next');
    expect(f.owner.targetInfo.targetId).toBe('target-10');
  });

  it('regression: an event without a tab is dropped and every later call names the extension reload', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;
    f.send.mockClear();

    f.fromExtension('forwardCDPEvent', { sessionId: 'owner', method: 'Page.loadEventFired', params: {} });
    await f.command(5, 'Runtime.evaluate');

    expect(f.events).toEqual([{ id: 5, sessionId: 'cdp-owner', error: { message: reloadMessage } }]);
    await expect(f.relay.createTab('owner')).rejects.toThrow(reloadMessage);
    await expect(f.relay.attachTab('owner', 20)).rejects.toThrow(reloadMessage);
    await expect(f.relay.recycleTab('owner')).rejects.toThrow(reloadMessage);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.owner.tabId).toBe(10);
  });

  it('regression: a command of a session without a tab is refused without reaching the extension', async () => {
    const f = createFixture();

    await f.command(6, 'Runtime.evaluate');

    expect(f.events).toEqual([{ id: 6, sessionId: 'cdp-owner', error: { message: 'No tab attached to session owner' } }]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('regression: a forwarded command names its tab and is bounded', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.send.mockClear();

    await f.command(7, 'Runtime.evaluate');

    expect(f.send.mock.calls).toEqual([
      ['forwardCDPCommand', { sessionId: 'owner', tabId: 10, cdpSessionId: undefined, method: 'Runtime.evaluate', params: {} }, { timeout: 605_000 }],
    ]);
  });
});

describe('extension command timer', () => {
  function connect() {
    const handlers: Record<string, (data: Buffer) => void> = {};
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), on: (event: string, handler: (data: Buffer) => void) => { handlers[event] = handler; } };
    const connection = new ExtensionConnection(socket as any);
    const reply = (message: object) => handlers.message(Buffer.from(JSON.stringify(message)));
    return { connection, reply };
  }

  it('regression: a reply clears the command timer', async () => {
    vi.useFakeTimers();
    try {
      const { connection, reply } = connect();
      const pending = connection.send('listTabs', {}, { timeout: 605_000 });
      expect(vi.getTimerCount()).toBe(1);

      reply({ id: 1, result: { tabs: [] } });

      await expect(pending).resolves.toEqual({ tabs: [] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('control: a command without a reply fails at its timeout', async () => {
    vi.useFakeTimers();
    try {
      const { connection } = connect();
      const pending = connection.send('listTabs', {}, { timeout: 605_000 });
      const outcome = expect(pending).rejects.toThrow('Extension command \'listTabs\' timed out after 605000ms');

      await vi.advanceTimersByTimeAsync(605_000);

      await outcome;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('recycle sideband route', () => {
  async function postRecycle(relay: CDPRelayServer, body: object) {
    const server = http.createServer();
    installRelayHTTPEndpoints(server, relay);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/tabs/recycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  it('recycles the tab of the posted session and answers with the re-attached tab', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;

    const answer = await postRecycle(f.relay, { sessionId: 'owner' });

    expect(answer).toMatchObject({ status: 200, body: { tabId: 10 } });
    expect(f.events.map(event => event.method)).toEqual(['Target.detachedFromTarget', 'Target.attachedToTarget']);
  });

  it('rejects a post without a session and answers a session without a tab with the relay error', async () => {
    const f = createFixture();

    expect(await postRecycle(f.relay, {})).toMatchObject({ status: 400, body: { error: 'sessionId is required' } });
    expect(await postRecycle(f.relay, { sessionId: 'owner' })).toMatchObject({ status: 500, body: { error: expect.stringContaining('has no tab to recycle') } });
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe('download behavior', () => {
  const setDownloadBehavior = (f: ReturnType<typeof createFixture>) => f.relay['_commandRouter'].handleMessage({
    id: 1,
    method: 'Browser.setDownloadBehavior',
    params: { behavior: 'allowAndName', downloadPath: '/tmp/playwright-artifacts-fixture', eventsEnabled: true },
  }, 'owner');

  it('control: Browser.setDownloadBehavior is answered empty and never reaches the extension', async () => {
    const f = createFixture();

    await setDownloadBehavior(f);

    expect(f.events).toEqual([{ id: 1, sessionId: undefined, result: {} }]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('regression: binding a tab sends the extension no Page.setDownloadBehavior, which Chrome always rejects', async () => {
    const f = createFixture();
    await setDownloadBehavior(f);

    await f.relay.attachTab('owner', 10);

    expect(f.send.mock.calls.map(([, params]) => (params as { method?: string }).method)).not.toContain('Page.setDownloadBehavior');
  });
});
