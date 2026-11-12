import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CDPCommandRouter } from 'playwright-core/src/mcp/cdpCommandRouter';
import { CDPRelayServer } from 'playwright-core/src/mcp/cdpRelay';
import { installRelayHTTPEndpoints } from 'playwright-core/src/mcp/relayHttpEndpoints';
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
    downloadBehavior: null,
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
  Object.assign(relay, {
    _clients: clients,
    _extensionConnection: extension,
    _extensionCommandTimeout: 100,
    _maxConcurrentClients: 10,
    _dormantSessions: new Map(),
    _sessionGrace: new SessionGraceManager(0),
    _sendToClient: sendToClient,
    _commandRouter: new CDPCommandRouter({
      getClient: id => clients.get(id),
      getExtensionConnection: () => extension as any,
      getState: () => 'connected',
      getExtensionCommandTimeout: () => 100,
      getDownloadsPath: () => undefined,
      sendToClient,
      bufferEvent: vi.fn(),
    }),
  });
  return { relay, owner, unrelated, events, unrelatedEvents, bindingAtSend, send, target };
}

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

  it('control: closing an unrelated tab preserves the active owner', async () => {
    const f = createFixture();
    await f.relay.attachTab('owner', 10);
    f.events.length = 0;

    f.relay['_handleExtensionMessage']('tabClosed', { sessionId: 'unknown', tabId: 99 });

    expect(f.events).toEqual([]);
    expect(f.unrelatedEvents).toEqual([]);
    expect(f.owner.tabId).toBe(10);
    expect(f.owner.targetInfo).toEqual(f.target(10));
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
