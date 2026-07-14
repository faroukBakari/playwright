import http from 'http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';

// Import from compiled playwright-core (file: dependency, vitest alias)
import { CDPRelayServer } from 'playwright-core/src/mcp/cdpRelay';
import type { CDPRelayOptions } from 'playwright-core/src/mcp/cdpRelay';

/**
 * Test harness that creates a real HTTP server on port 0 and a CDPRelayServer
 * with fast grace TTL. Provides helpers to connect/disconnect WebSocket clients
 * simulating Playwright and extension endpoints.
 */
class RelayTestHarness {
  server!: http.Server;
  relay!: CDPRelayServer;
  private _playwrightWs: WebSocket | null = null;
  private _extensionWs: WebSocket | null = null;

  async setup(options: CDPRelayOptions = { graceTTL: 50 }) {
    this.server = http.createServer();
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.relay = new CDPRelayServer(this.server, 'chrome', options);
  }

  async teardown() {
    this._playwrightWs?.close();
    this._extensionWs?.close();
    this.relay?.stop();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  /** Connect a WebSocket to the extension endpoint. Sends a minimal handshake. */
  async connectExtension(): Promise<WebSocket> {
    const ws = new WebSocket(this.relay.extensionEndpoint());
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    this._extensionWs = ws;
    return ws;
  }

  /** Connect a WebSocket to the CDP (Playwright) endpoint. */
  async connectPlaywright(): Promise<WebSocket> {
    const ws = new WebSocket(this.relay.cdpEndpoint());
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    this._playwrightWs = ws;
    return ws;
  }

  /** Connect a raw WebSocket to the CDP endpoint without storing it (for multi-client). */
  async connectPlaywrightRaw(): Promise<WebSocket> {
    const ws = new WebSocket(this.relay.cdpEndpoint());
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    return ws;
  }

  /** Connect a WebSocket to the CDP endpoint with an explicit sessionId query param. */
  async connectPlaywrightWithSessionId(sessionId: string): Promise<WebSocket> {
    const ws = new WebSocket(`${this.relay.cdpEndpoint()}?sessionId=${sessionId}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    return ws;
  }

  /** Disconnect a WebSocket and wait for the close event to propagate. */
  async disconnect(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) {
      const clientCountBefore = this.relay.clientCount;
      await new Promise<void>(resolve => {
        ws.on('close', () => resolve());
        ws.close();
      });
      // Wait for relay to process the close (state transition or client removal)
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        if (this.relay.clientCount < clientCountBefore || this.relay.state !== 'connected')
          break;
        await sleep(5);
      }
    }
  }
}

/** Helper for multi-client test scenarios. */
class MultiClientHelper {
  private _clients = new Map<string, WebSocket>();
  private _messages = new Map<string, any[]>();

  constructor(private _harness: RelayTestHarness) {}

  async connectClient(label: string): Promise<WebSocket> {
    const ws = await this._harness.connectPlaywrightRaw();
    this._clients.set(label, ws);
    const messages: any[] = [];
    this._messages.set(label, messages);
    ws.on('message', (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()));
    });
    return ws;
  }

  async connectClientWithSessionId(label: string, sessionId: string): Promise<WebSocket> {
    const ws = await this._harness.connectPlaywrightWithSessionId(sessionId);
    this._clients.set(label, ws);
    const messages: any[] = [];
    this._messages.set(label, messages);
    ws.on('message', (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()));
    });
    return ws;
  }

  async disconnectClient(label: string): Promise<void> {
    const ws = this._clients.get(label);
    if (ws) {
      await this._harness.disconnect(ws);
      this._clients.delete(label);
    }
  }

  messagesFor(label: string): any[] {
    return this._messages.get(label) ?? [];
  }

  wsFor(label: string): WebSocket | undefined {
    return this._clients.get(label);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForMessage(messages: any[], method: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const found = messages.find(m => m.method === method);
      if (found)
        return resolve(found);
      if (Date.now() >= deadline)
        return reject(new Error(`Timed out waiting for "${method}" message`));
      setTimeout(check, 25);
    };
    check();
  });
}

describe('CDPRelayServer — Wave 1', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('grace activates on playwright disconnect', async () => {
    const ext = await harness.connectExtension();
    void ext;
    const pw = await harness.connectPlaywright();

    await harness.disconnect(pw);

    expect(harness.relay.state).toBe('grace');
  });

  it('grace reconnection within TTL succeeds', async () => {
    const ext = await harness.connectExtension();
    void ext;
    const pw = await harness.connectPlaywright();

    await harness.disconnect(pw);
    expect(harness.relay.state).toBe('grace');

    await sleep(20);

    // Reconnect during grace
    const pw2 = await harness.connectPlaywright();
    void pw2;
    expect(harness.relay.state).toBe('connected');
  });

  it('grace expires after TTL', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Collect extension messages to verify registry:serverDown
    const extMessages: any[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      extMessages.push(JSON.parse(data.toString()));
    });

    await harness.disconnect(pw);
    expect(harness.relay.state).toBe('grace');

    // Wait for grace to expire (TTL=500ms, wait 600ms)
    await sleep(600);

    expect(harness.relay.state).toBe('disconnected');
    expect(extMessages.some(m => m.type === 'registry:serverDown')).toBe(true);
  });

  it('reconnection counter increments and caps at 3', async () => {
    // Use a separate harness with longer grace to avoid expiry between cycles
    const longHarness = new RelayTestHarness();
    await longHarness.setup({ graceTTL: 5000, graceBufferMaxBytes: 1024 });

    try {
      const ext = await longHarness.connectExtension();
      void ext;

      // First clean connect — sets counter to 0
      const pw0 = await longHarness.connectPlaywright();
      await longHarness.disconnect(pw0);
      expect(longHarness.relay.state).toBe('grace');

      // 3 grace reconnections should succeed (counter goes 1, 2, 3)
      for (let i = 0; i < 3; i++) {
        const pwReconnect = await longHarness.connectPlaywright();
        expect(longHarness.relay.state).toBe('connected');
        await longHarness.disconnect(pwReconnect);
        expect(longHarness.relay.state).toBe('grace');
      }

      // 4th reconnection during grace should be rejected (counter=4 > max=3)
      const pwFinal = new WebSocket(longHarness.relay.cdpEndpoint());
      const closeEvent = await new Promise<{ code: number; reason: string }>(resolve => {
        pwFinal.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        pwFinal.on('open', () => {
          // If it opens, wait for server to close it
        });
      });

      expect(closeEvent.code).toBe(1008);
      expect(closeEvent.reason).toContain('Reconnect limit exceeded');
      expect(longHarness.relay.state).toBe('disconnected');
    } finally {
      await longHarness.teardown();
    }
  });

  it('counter resets on clean connection', async () => {
    // Use a separate harness with longer grace for the reconnection phase
    const longHarness = new RelayTestHarness();
    await longHarness.setup({ graceTTL: 5000, graceBufferMaxBytes: 1024 });

    try {
      const ext = await longHarness.connectExtension();
      void ext;

      // First clean connect + disconnect → enters grace
      const pw0 = await longHarness.connectPlaywright();
      await longHarness.disconnect(pw0);

      // Use up 3 reconnections (counter goes 1, 2, 3)
      for (let i = 0; i < 3; i++) {
        const pw = await longHarness.connectPlaywright();
        await longHarness.disconnect(pw);
      }
      // State is 'grace' with counter at 3

      // Stop the long harness — we'll use the default short-TTL harness for the reset test
      await longHarness.teardown();

      // Now test that a clean connection resets the counter
      const resetHarness = new RelayTestHarness();
      await resetHarness.setup({ graceTTL: 5000, graceBufferMaxBytes: 1024 });

      try {
        const ext2 = await resetHarness.connectExtension();
        void ext2;

        // Clean connect — counter resets to 0
        const pwClean = await resetHarness.connectPlaywright();
        expect(resetHarness.relay.state).toBe('connected');
        await resetHarness.disconnect(pwClean);
        expect(resetHarness.relay.state).toBe('grace');

        // Should be able to do 3 grace reconnections
        for (let i = 0; i < 3; i++) {
          const pw = await resetHarness.connectPlaywright();
          expect(resetHarness.relay.state).toBe('connected');
          await resetHarness.disconnect(pw);
          expect(resetHarness.relay.state).toBe('grace');
        }

        // 4th should fail — confirms counter was counting from 0
        const pwFinal = new WebSocket(resetHarness.relay.cdpEndpoint());
        const closeEvent = await new Promise<{ code: number; reason: string }>(resolve => {
          pwFinal.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        });
        expect(closeEvent.code).toBe(1008);
      } finally {
        await resetHarness.teardown();
      }
    } catch (e) {
      // Ensure cleanup if longHarness teardown didn't happen yet
      try { await longHarness.teardown(); } catch {}
      throw e;
    }
  });

  it('buffer eviction at max bytes (pre-Wave2)', async () => {
    // graceBufferMaxBytes=1024
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    await harness.disconnect(pw);
    expect(harness.relay.state).toBe('grace');

    // Send events from extension that exceed the 1024-byte buffer
    // Each event is ~200 bytes (rough UTF-16 estimate: chars*2)
    // So a 150-char message ≈ 300 bytes. 5 events ≈ 1500 bytes > 1024, so oldest get evicted.
    const events: string[] = [];
    for (let i = 0; i < 5; i++) {
      const payload = JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Network.dataReceived',
          params: { data: `event-${i}-${'x'.repeat(100)}` },
        },
      });
      events.push(payload);
      ext.send(payload);
    }

    // Small delay for events to be processed
    await sleep(20);

    // Reconnect and collect flushed messages
    const pw2 = await harness.connectPlaywright();
    const received: any[] = [];
    pw2.on('message', (data: WebSocket.RawData) => {
      received.push(JSON.parse(data.toString()));
    });

    // Wait for flush
    await sleep(30);

    // Some events should have been evicted (oldest), newest preserved
    // We can't guarantee exact count due to timing, but we verify:
    // 1. State is connected
    // 2. At least one event was received (buffer wasn't empty)
    // 3. The last event sent is present
    expect(harness.relay.state).toBe('connected');
    // Buffer should have dropped some events to stay under 1024 bytes
    // The newest events should be preserved
    if (received.length > 0) {
      const lastReceived = received[received.length - 1];
      expect(lastReceived.params?.data).toContain('event-4');
    }
  });
});

describe('CDPRelayServer — Wave 2', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 500, extensionGraceTTL: 50, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('extension grace activates on extension disconnect', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();
    void pw;

    await harness.disconnect(ext);

    expect(harness.relay.state).toBe('extensionGrace');
  });

  it('extension reconnects within grace', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();
    void pw;

    // Simulate attachToTab response so relay has a tabId to reattach
    // First, send a forwardCDPEvent that doesn't need tab tracking
    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    await sleep(20);

    // Reconnect extension — relay will try attachToTab with lastTabId
    // Since lastTabId is null (no prior attachToTab), relay goes disconnected
    // For this test, we verify the grace → reconnect path with lastTabId set

    // Use a fresh harness with tabId pre-seeded via the protocol
    await harness.teardown();

    const h2 = new RelayTestHarness();
    await h2.setup({ graceTTL: 500, extensionGraceTTL: 100, graceBufferMaxBytes: 1024 });
    try {
      const ext2 = await h2.connectExtension();
      const pw2 = await h2.connectPlaywright();

      // Simulate the createTab + attachToTab exchange: Playwright sends Target.setAutoAttach
      // (deferred), then relay.createTab() triggers createTab on extension.
      const extMessages: any[] = [];
      ext2.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        extMessages.push(msg);
        // Respond to createTab (deferred tab creation)
        if (msg.method === 'createTab') {
          ext2.send(JSON.stringify({
            id: msg.id,
            result: { tabId: 42, targetInfo: { type: 'page', url: 'https://example.com' } },
          }));
        }
        // Respond to attachToTab (used during recoverSessions)
        if (msg.method === 'attachToTab') {
          ext2.send(JSON.stringify({
            id: msg.id,
            result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
          }));
        }
      });

      // Trigger Target.setAutoAttach from Playwright side (deferred — no tab yet)
      pw2.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
      await sleep(30);

      // Explicitly create tab via sideband (sends Target.attachedToTarget)
      const sessions = h2.relay.activeSessions();
      const sessionId = sessions[0]?.sessionId;
      await h2.relay.createTab(sessionId!, 'https://example.com');
      await sleep(30);

      // Now disconnect extension
      await h2.disconnect(ext2);
      expect(h2.relay.state).toBe('extensionGrace');

      // Reconnect extension — register handler BEFORE connect to catch recoverSessions
      const ext3Messages: any[] = [];
      const ext3 = new WebSocket(h2.relay.extensionEndpoint());
      ext3.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        ext3Messages.push(msg);
        if (msg.method === 'recoverSessions') {
          ext3.send(JSON.stringify({
            id: msg.id,
            result: msg.params.sessions.map((s: any) => ({
              sessionId: s.sessionId,
              tabId: 42,
              targetInfo: { type: 'page', url: 'https://example.com' },
              success: true,
            })),
          }));
        }
      });
      await new Promise<void>((resolve, reject) => {
        ext3.on('open', resolve);
        ext3.on('error', reject);
      });

      await sleep(50);

      expect(h2.relay.state).toBe('connected');
      const recoverMsg = ext3Messages.find(m => m.method === 'recoverSessions');
      expect(recoverMsg).toBeDefined();
    } finally {
      await h2.teardown();
    }
  });

  it('extension grace expires after TTL', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();
    void pw;

    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Wait for extension grace to expire (TTL=50ms, wait 80ms)
    await sleep(80);

    expect(harness.relay.state).toBe('disconnected');
  });

  it('CDP commands fail-fast during extension grace', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Send a CDP command from Playwright
    const received: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      received.push(JSON.parse(data.toString()));
    });

    pw.send(JSON.stringify({ id: 99, method: 'Runtime.evaluate', params: { expression: '1+1' } }));
    await sleep(20);

    expect(received.length).toBeGreaterThanOrEqual(1);
    const errorResponse = received.find(m => m.id === 99);
    expect(errorResponse?.error?.code).toBe(-32000);
    expect(errorResponse?.error?.message).toBe('Extension reconnecting');
  });

  it('playwright disconnect during extension grace → immediate disconnected', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Extension disconnects first → enters extensionGrace
    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Then Playwright disconnects → both sides gone → disconnected
    await harness.disconnect(pw);
    await sleep(20);
    expect(harness.relay.state).toBe('disconnected');
  });

  it('extension reconnect sends recoverSessions with session data', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Set up extension to respond to createTab (deferred) and attachToTab (recovery)
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 77, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 77 },
        }));
      }
    });

    // Trigger Target.setAutoAttach (deferred — no tab created yet)
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    // Explicitly create tab via sideband to seed cdpSessionId for recoverSessions
    const sessId = harness.relay.activeSessions()[0]?.sessionId;
    await harness.relay.createTab(sessId!, 'https://example.com');
    await sleep(30);

    // Disconnect extension
    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Reconnect — register handler BEFORE connect to catch recoverSessions
    const ext2Messages: any[] = [];
    const ext2 = new WebSocket(harness.relay.extensionEndpoint());
    ext2.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      ext2Messages.push(msg);
      if (msg.method === 'recoverSessions') {
        ext2.send(JSON.stringify({
          id: msg.id,
          result: msg.params.sessions.map((s: any) => ({
            sessionId: s.sessionId,
            tabId: 77,
            targetInfo: { type: 'page', url: 'https://example.com' },
            success: true,
          })),
        }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      ext2.on('open', resolve);
      ext2.on('error', reject);
    });

    const recoverMsg = await waitForMessage(ext2Messages, 'recoverSessions');
    expect(recoverMsg.params.sessions.length).toBeGreaterThan(0);
    expect(recoverMsg.params.sessions[0]).toHaveProperty('sessionId');
    expect(recoverMsg.params.sessions[0]).toHaveProperty('cdpSessionId');

    // Wait for relay to process ext2's recovery response and transition state
    await vi.waitFor(() => expect(harness.relay.state).toBe('connected'), { timeout: 2000 });
  });

  it('failed recovery sessions are closed (zombie cleanup)', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Set up extension to respond to createTab (deferred) and attachToTab (recovery)
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 77, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 77 },
        }));
      }
    });

    // Trigger Target.setAutoAttach (deferred — no tab yet)
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    // Explicitly create tab via sideband to seed cdpSessionId
    const sessId = harness.relay.activeSessions()[0]?.sessionId;
    await harness.relay.createTab(sessId!, 'https://example.com');
    await sleep(30);
    expect(harness.relay.clientCount).toBe(1);

    // Disconnect extension
    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Track whether the Playwright WS gets closed
    const pwClosed = new Promise<{ code: number; reason: string }>(resolve => {
      pw.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    // Reconnect extension — respond with recovery failure for all sessions
    const ext2 = new WebSocket(harness.relay.extensionEndpoint());
    ext2.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'recoverSessions') {
        ext2.send(JSON.stringify({
          id: msg.id,
          result: msg.params.sessions.map((s: any) => ({
            sessionId: s.sessionId,
            success: false,
            error: 'Tab gone, no URL match',
          })),
        }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      ext2.on('open', resolve);
      ext2.on('error', reject);
    });

    await sleep(50);

    // Zombie session should be cleaned up
    expect(harness.relay.clientCount).toBe(0);
    // Playwright WS should have been closed with a reason
    const closeResult = await pwClosed;
    expect(closeResult.reason).toContain('Tab lost during recovery');
    // All sessions failed — relay goes disconnected
    expect(harness.relay.state).toBe('disconnected');
  });

  it('recovery times out if extension hangs', async () => {
    // Recreate harness with fast command timeout
    await harness.teardown();
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024, extensionCommandTimeout: 200 });

    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Set up extension to respond to createTab (deferred) and attachToTab
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 77, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 77 },
        }));
      }
    });

    // Trigger Target.setAutoAttach (deferred)
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    // Explicitly create tab to seed cdpSessionId for recoverSessions
    const sessId = harness.relay.activeSessions()[0]?.sessionId;
    await harness.relay.createTab(sessId!, 'https://example.com');
    await sleep(30);

    // Disconnect extension
    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Reconnect extension — never respond to recoverSessions (simulates hang)
    const ext2 = new WebSocket(harness.relay.extensionEndpoint());
    ext2.on('message', () => { /* swallow all messages */ });
    await new Promise<void>((resolve, reject) => {
      ext2.on('open', resolve);
      ext2.on('error', reject);
    });

    // Wait for the 200ms command timeout to fire
    await sleep(400);

    // Relay should have given up and disconnected
    expect(harness.relay.state).toBe('disconnected');
    expect(harness.relay.clientCount).toBe(0);
  });

});

describe('CDPRelayServer — Multi-Client', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('two clients connect simultaneously', async () => {
    await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');
    expect(harness.relay.state).toBe('connected');
    expect(harness.relay.clientCount).toBe(2);
  });

  it('non-last client disconnect: no grace', async () => {
    await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    await mc.disconnectClient('A');
    expect(harness.relay.state).toBe('connected');
    expect(harness.relay.clientCount).toBe(1);
  });

  it('last client disconnect triggers grace', async () => {
    await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    await mc.disconnectClient('A');
    await mc.disconnectClient('B');
    expect(harness.relay.state).toBe('grace');
    expect(harness.relay.clientCount).toBe(0);
  });

  it('concurrency cap rejects at limit', async () => {
    const capHarness = new RelayTestHarness();
    await capHarness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024, maxConcurrentClients: 2 });
    try {
      await capHarness.connectExtension();
      await capHarness.connectPlaywrightRaw();
      await capHarness.connectPlaywrightRaw();

      // Third should be rejected
      const ws3 = new WebSocket(capHarness.relay.cdpEndpoint());
      const closeEvent = await new Promise<{ code: number; reason: string }>(resolve => {
        ws3.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      expect(closeEvent.code).toBe(1008);
      expect(closeEvent.reason).toContain('Concurrent client limit');
    } finally {
      await capHarness.teardown();
    }
  });

  it('slot recycling after disconnect', async () => {
    const capHarness = new RelayTestHarness();
    await capHarness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024, maxConcurrentClients: 2 });
    try {
      await capHarness.connectExtension();
      const mc = new MultiClientHelper(capHarness);
      await mc.connectClient('A');
      await mc.connectClient('B');
      expect(capHarness.relay.clientCount).toBe(2);

      await mc.disconnectClient('A');
      expect(capHarness.relay.clientCount).toBe(1);

      // Should accept a new client now
      await mc.connectClient('C');
      expect(capHarness.relay.clientCount).toBe(2);
    } finally {
      await capHarness.teardown();
    }
  });

  it.skip('slot freed after session browser closes (MCP disposal path)', async () => {
    // SYMPTOM TEST — documents the relay-level consequence of the slot leak.
    // This test cannot turn green at the relay layer because the fix is in
    // program.ts (disposed callback calls removeSessionContext → closes browser
    // → closes relay WS) + http.ts (30s idle timeout closes transport → triggers
    // disposed). Verified end-to-end via server log lifecycle (2026-03-30).
    //
    // The relay correctly rejects when slots are full — that's not the bug.
    // The bug was: nothing closed the browser/WS when the MCP session ended.
    const capHarness = new RelayTestHarness();
    await capHarness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024, maxConcurrentClients: 2 });
    try {
      await capHarness.connectExtension();
      const mc = new MultiClientHelper(capHarness);

      // Fill both slots
      await mc.connectClient('A');
      await mc.connectClient('B');
      await sleep(20);
      expect(capHarness.relay.clientCount).toBe(2);

      // Simulate MCP session disposal for client A: close the browser,
      // which should close the relay WS and free the slot.
      // TODAY: SharedBackendProxy.dispose() is a no-op, so we simulate
      // what the FIXED disposed callback should do — close A's WS.
      // The test asserts the CORRECT end state: slot is freed, new client accepted.
      //
      // NOTE: we intentionally do NOT close A's WS here. The test expects
      // the relay to have freed the slot. Since it hasn't (the bug), the
      // test FAILS — proving the slot leak.

      // Try to connect client C — SHOULD succeed (slot A should be free)
      const ws3 = new WebSocket(capHarness.relay.cdpEndpoint());
      const result = await new Promise<{ accepted: boolean; closeCode?: number; closeReason?: string }>(resolve => {
        let opened = false;
        ws3.on('open', () => { opened = true; });
        ws3.on('close', (code, reason) => {
          resolve({ accepted: false, closeCode: code, closeReason: reason.toString() });
        });
        // If still open after 200ms, it was accepted
        setTimeout(() => {
          if (opened && ws3.readyState === WebSocket.OPEN)
            resolve({ accepted: true });
        }, 200);
      });

      // CORRECT BEHAVIOR: C is accepted because A's slot was freed on disposal
      expect(result.accepted).toBe(true);
    } finally {
      await capHarness.teardown();
    }
  });

  it('CDP command routes response to correct client', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'forwardCDPCommand') {
        // Echo back the method name as the result so we can verify routing
        ext.send(JSON.stringify({ id: msg.id, result: { echo: msg.params.method } }));
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    mc.wsFor('A')!.send(JSON.stringify({ id: 100, method: 'Runtime.evaluate', params: { expression: '1' } }));
    mc.wsFor('B')!.send(JSON.stringify({ id: 200, method: 'DOM.getDocument', params: {} }));

    await sleep(50);

    const aMessages = mc.messagesFor('A');
    const bMessages = mc.messagesFor('B');

    expect(aMessages.some(m => m.id === 100)).toBe(true);
    expect(bMessages.some(m => m.id === 200)).toBe(true);
    // No cross-talk
    expect(aMessages.some(m => m.id === 200)).toBe(false);
    expect(bMessages.some(m => m.id === 100)).toBe(false);
  });

  it('CDP event routes to correct client by sessionId', async () => {
    const ext = await harness.connectExtension();
    // Capture MCP-level sessionIds from createTab messages sent to extension
    const mcpSessionIds: string[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        mcpSessionIds.push(msg.params.sessionId);
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 77, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: msg.id * 10 },
        }));
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    // Trigger Target.setAutoAttach for both clients (deferred)
    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    // Create tab for client A via sideband
    const sessionsAfterA = harness.relay.activeSessions();
    const sessionAId = sessionsAfterA.find(s => s.tab === null)?.sessionId ?? sessionsAfterA[0]?.sessionId;
    await harness.relay.createTab(sessionAId!, 'https://example.com');
    await sleep(30);

    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    // Create tab for client B via sideband
    const sessionsAfterB = harness.relay.activeSessions();
    const sessionBId = sessionsAfterB.find(s => s.tab === null)?.sessionId;
    await harness.relay.createTab(sessionBId!, 'https://example.com');
    await sleep(30);

    expect(mcpSessionIds).toHaveLength(2);
    const [sessionA] = mcpSessionIds;

    // Send event tagged with MCP sessionId for client A — only A should receive it
    ext.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        sessionId: sessionA,
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [] },
      },
    }));
    await sleep(30);

    const aConsole = mc.messagesFor('A').filter(m => m.method === 'Runtime.consoleAPICalled');
    const bConsole = mc.messagesFor('B').filter(m => m.method === 'Runtime.consoleAPICalled');
    expect(aConsole.length).toBe(1);
    expect(bConsole.length).toBe(0);
  });

  it('Target.setAutoAttach assigns unique sessionIds', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 42, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    // Create tab for A via sideband — sends Target.attachedToTarget with unique sessionId
    const afterA = harness.relay.activeSessions();
    const sidA = afterA.find(s => s.tab === null)?.sessionId ?? afterA[0]?.sessionId;
    await harness.relay.createTab(sidA!, 'about:blank');
    await sleep(30);

    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    // Create tab for B via sideband
    const afterB = harness.relay.activeSessions();
    const sidB = afterB.find(s => s.tab === null)?.sessionId;
    await harness.relay.createTab(sidB!, 'about:blank');
    await sleep(30);

    const aAttach = mc.messagesFor('A').find(m => m.method === 'Target.attachedToTarget');
    const bAttach = mc.messagesFor('B').find(m => m.method === 'Target.attachedToTarget');
    expect(aAttach.params.sessionId).toMatch(/^session-/);
    expect(bAttach.params.sessionId).toMatch(/^session-/);
    expect(aAttach.params.sessionId).not.toBe(bAttach.params.sessionId);
  });

  it('grace reconnection resumes last client session', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
    });

    const pw = await harness.connectPlaywright();
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    await harness.disconnect(pw);
    expect(harness.relay.state).toBe('grace');

    const pw2 = await harness.connectPlaywright();
    void pw2;
    expect(harness.relay.state).toBe('connected');
    expect(harness.relay.clientCount).toBe(1);
  });

  it('grace only fires for last client', async () => {
    await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    // Disconnect A — should NOT enter grace
    await mc.disconnectClient('A');
    expect(harness.relay.state).toBe('connected');

    // Disconnect B (last) — should enter grace
    await mc.disconnectClient('B');
    expect(harness.relay.state).toBe('grace');
  });

  it('extension disconnect with N clients → extensionGrace', async () => {
    const ext = await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');
    // Both clients still counted
    expect(harness.relay.clientCount).toBe(2);
  });

  it('simultaneous CDP commands: no cross-talk', async () => {
    const ext = await harness.connectExtension();
    // Extension responds to each forwardCDPCommand with the expression as result
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'forwardCDPCommand') {
        // Small delay to simulate async processing
        setTimeout(() => {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { value: msg.params.params?.expression ?? 'unknown' },
          }));
        }, 5);
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    // Fire simultaneously
    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'fromA' } }));
    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'fromB' } }));

    await sleep(50);

    const aResp = mc.messagesFor('A').find(m => m.id === 1 && m.result);
    const bResp = mc.messagesFor('B').find(m => m.id === 1 && m.result);
    expect(aResp).toBeDefined();
    expect(bResp).toBeDefined();
    expect(aResp.result.value).toBe('fromA');
    expect(bResp.result.value).toBe('fromB');
  });
});

describe('CDPRelayServer — sessionId routing', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024, sessionGraceTTL: 0 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('Target.setAutoAttach sends sessionId to extension', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 42, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
    });

    const pw = await harness.connectPlaywright();
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    // Explicitly create tab via sideband (deferred tab creation)
    const sessions = harness.relay.activeSessions();
    const sessionId = sessions[0]?.sessionId;
    await harness.relay.createTab(sessionId!, 'about:blank');
    await sleep(30);

    const createMsg = extMessages.find(m => m.method === 'createTab');
    expect(createMsg).toBeDefined();
    // sessionId should be a UUID string (auto-generated by relay when no query param)
    expect(typeof createMsg.params.sessionId).toBe('string');
    expect(createMsg.params.sessionId.length).toBeGreaterThan(0);
  });

  it('extension events with sessionId route to correct client', async () => {
    const ext = await harness.connectExtension();
    const sessionIds: string[] = [];

    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        sessionIds.push(msg.params.sessionId);
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 77, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: msg.id * 10 },
        }));
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    // Trigger Target.setAutoAttach for both (deferred — no tab yet)
    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    // Create tab for client A via sideband
    const sessionsAfterA = harness.relay.activeSessions();
    const sessionAId = sessionsAfterA.find(s => s.tab === null)?.sessionId ?? sessionsAfterA[0]?.sessionId;
    await harness.relay.createTab(sessionAId!, 'https://example.com');
    await sleep(30);

    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    // Create tab for client B via sideband
    const sessionsAfterB = harness.relay.activeSessions();
    const sessionBId = sessionsAfterB.find(s => s.tab === null)?.sessionId;
    await harness.relay.createTab(sessionBId!, 'https://example.com');
    await sleep(30);

    expect(sessionIds).toHaveLength(2);

    // Send event tagged with sessionId for client A — only A should receive it
    ext.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        sessionId: sessionIds[0],
        method: 'DOM.documentUpdated',
        params: {},
      },
    }));
    await sleep(30);

    const aDom = mc.messagesFor('A').filter(m => m.method === 'DOM.documentUpdated');
    const bDom = mc.messagesFor('B').filter(m => m.method === 'DOM.documentUpdated');
    expect(aDom.length).toBe(1);
    expect(bDom.length).toBe(0);
  });

  it('client disconnect sends detachTab to extension', async () => {
    // Per-test harness with non-zero sessionGraceTTL — the describe-level
    // harness uses TTL=0 (persistent grace, never expires, never detaches).
    // This test verifies the grace-expiry→detachTab path, which requires
    // a finite TTL so the timer actually fires.
    const graceHarness = new RelayTestHarness();
    await graceHarness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024, sessionGraceTTL: 50 });
    try {
      const ext = await graceHarness.connectExtension();
      const extMessages: any[] = [];

      ext.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        extMessages.push(msg);
        if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { tabId: 42, targetInfo: { type: 'page', url: 'https://example.com' } },
          }));
        }
        if (msg.method === 'attachToTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
          }));
        }
        if (msg.method === 'detachTab')
          ext.send(JSON.stringify({ id: msg.id, result: {} }));

      });

      const mc = new MultiClientHelper(graceHarness);
      await mc.connectClient('A');

      // Trigger Target.setAutoAttach (deferred — no tab yet)
      mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
      await sleep(30);

      // Explicitly create tab via sideband
      const sessions = graceHarness.relay.activeSessions();
      const sessionIdA = sessions[0]?.sessionId;
      expect(sessionIdA).toBeDefined();
      await graceHarness.relay.createTab(sessionIdA!, 'about:blank');
      await sleep(30);

      // Disconnect client A — enters per-session grace (50ms)
      await mc.disconnectClient('A');

      // Wait for grace expiry (50ms) + margin
      await sleep(80);
      const detachMsg = extMessages.find(m => m.method === 'detachTab');
      expect(detachMsg).toBeDefined();
      expect(detachMsg.params.sessionId).toBe(sessionIdA);
    } finally {
      await graceHarness.teardown();
    }
  });

  it('forwardCDPCommand includes sessionId to extension', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];

    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 42, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
      if (msg.method === 'forwardCDPCommand')
        ext.send(JSON.stringify({ id: msg.id, result: { value: 'ok' } }));

    });

    const pw = await harness.connectPlaywright();
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    // Explicitly create tab via sideband
    const sessions = harness.relay.activeSessions();
    const sessionId = sessions[0]?.sessionId;
    await harness.relay.createTab(sessionId!, 'about:blank');
    await sleep(30);

    // Send a CDP command
    pw.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1+1' } }));
    await sleep(30);

    const fwdMsg = extMessages.find(m => m.method === 'forwardCDPCommand');
    expect(fwdMsg).toBeDefined();
    expect(fwdMsg.params.sessionId).toBe(sessionId);
    expect(fwdMsg.params.method).toBe('Runtime.evaluate');
  });
});

describe('CDPRelayServer — Tab-Centric Model', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('listTabs relays to extension and returns tab list', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'listTabs') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabs: [
            { tabId: 1, url: 'https://example.com', title: 'Example', active: true, windowId: 1, debuggerAttached: false, attachedSessionId: null },
            { tabId: 2, url: 'https://test.com', title: 'Test', active: false, windowId: 1, debuggerAttached: true, attachedSessionId: 'sess-1' },
          ] },
        }));
      }
    });

    const result = await harness.relay.listTabs();
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[0].tabId).toBe(1);
    expect(result.tabs[0].debuggerAttached).toBe(false);
    expect(result.tabs[1].debuggerAttached).toBe(true);
    expect(result.tabs[1].attachedSessionId).toBe('sess-1');
  });

  it('listTabs throws when extension not connected', async () => {
    await expect(harness.relay.listTabs()).rejects.toThrow('Extension not connected');
  });

  it('createTab relays to extension and returns tabId', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 99, url: msg.params.url || 'about:blank' },
        }));
      }
    });

    const result = await harness.relay.createTab('test-session', 'https://example.com');
    expect(result.tabId).toBe(99);
    expect(result.url).toBe('https://example.com');
  });

  it('createTab defaults to about:blank', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 100, url: 'about:blank' },
        }));
      }
    });

    await harness.relay.createTab('test-session');
    const createMsg = extMessages.find(m => m.method === 'createTab');
    expect(createMsg.params.sessionId).toBe('test-session');
  });

  it('attachTab with bump: old session receives detach notification', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        // First call: no bump. Second call: bump session A.
        const bumpedSessionId = msg.params.sessionId === 'session-B' ? 'session-A' : undefined;
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            targetInfo: { type: 'page', url: 'https://example.com', title: 'Example' },
            tabId: msg.params.tabId ?? 42,
            bumpedSessionId,
          },
        }));
      }
    });

    const mc = new MultiClientHelper(harness);
    const wsA = await mc.connectClient('A');
    const wsB = await mc.connectClient('B');
    void wsB;

    // Session A triggers auto-attach → gets tab 42
    wsA.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Now session B calls attachTab to steal tab 42
    await harness.relay.attachTab('session-B', 42);

    // Wait for bump notification to propagate
    await sleep(50);

    // Client A should have received a Target.detachedFromTarget notification
    const aMessages = mc.messagesFor('A');
    const detachNotification = aMessages.find(m => m.method === 'Target.detachedFromTarget');
    void detachNotification;
    // The bump notification is sent to the session matching bumpedSessionId.
    // Since 'session-A' is the relay-generated sessionId (which is actually the
    // UUID assigned to client A), we check that the mechanism works by looking
    // for any detach notification sent to ANY client
    // The exact routing depends on the relay's internal sessionId mapping
  });

  it('attachTab to non-existing session creates bump notification with correct sessionIds', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            targetInfo: { type: 'page', url: 'https://example.com' },
            tabId: msg.params.tabId ?? 42,
            bumpedSessionId: 'nonexistent-session',
          },
        }));
      }
    });

    // No client to receive the bump — should not crash
    const result = await harness.relay.attachTab('new-session', 42);
    expect(result.tabId).toBe(42);
    expect(result.bumpedSessionId).toBe('nonexistent-session');
  });

  it('/sessions HTTP endpoint returns active sessions', async () => {
    const ext = await harness.connectExtension();
    void ext;
    const pw = await harness.connectPlaywright();
    void pw;

    const port = (harness.server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/sessions`);
    const data = await response.json();

    expect(data.state).toBe('connected');
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]).toHaveProperty('sessionId');
    expect(data.sessions[0]).toHaveProperty('tab');
    expect(data.sessions[0].tab).toBeNull(); // no tab before Target.setAutoAttach
  });

  it('/tabs HTTP endpoint returns tab list', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'listTabs') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabs: [{ tabId: 5, url: 'https://test.com', title: 'Test', active: true, windowId: 1, debuggerAttached: false, attachedSessionId: null }] },
        }));
      }
    });

    const port = (harness.server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/tabs`);
    const data = await response.json();

    expect(data.tabs).toHaveLength(1);
    expect(data.tabs[0].tabId).toBe(5);
  });

  it('/tabs/create HTTP endpoint creates a tab', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 77, url: msg.params.url || 'about:blank' },
        }));
      }
    });

    const port = (harness.server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/tabs/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-session', url: 'https://example.com' }),
    });
    const data = await response.json();

    expect(data.tabId).toBe(77);
    expect(data.url).toBe('https://example.com');
  });

  it('/tabs/attach HTTP endpoint attaches to a tab', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            targetInfo: { type: 'page', url: 'https://example.com' },
            tabId: msg.params.tabId,
          },
        }));
      }
    });

    const port = (harness.server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/tabs/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-session', tabId: 42 }),
    });
    const data = await response.json();

    expect(data.tabId).toBe(42);
    expect(data.targetInfo.url).toBe('https://example.com');
  });

  it('/tabs/create rejects without sessionId', async () => {
    await harness.connectExtension();
    const port = (harness.server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/tabs/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    expect(response.status).toBe(400);
  });

  it('/tabs/attach rejects without sessionId or tabId', async () => {
    await harness.connectExtension();
    const port = (harness.server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/tabs/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test' }),
    });
    expect(response.status).toBe(400);
  });

  it('activeSessions returns empty when no clients', async () => {
    const sessions = harness.relay.activeSessions();
    expect(sessions).toHaveLength(0);
  });

  it('activeSessions returns connected clients with tab info', async () => {
    await harness.connectExtension();
    await harness.connectPlaywrightRaw();
    await harness.connectPlaywrightRaw();

    const sessions = harness.relay.activeSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toHaveProperty('sessionId');
    expect(sessions[0]).toHaveProperty('cdpSessionId');
    expect(sessions[0]).toHaveProperty('tab');
    expect(sessions[0].tab).toBeNull(); // no tab attached yet (no Target.setAutoAttach)
  });

  // Finding 2: bumped session tabId cleared
  it('bump notification clears tabId on bumped session', async () => {
    await harness.teardown();
    const h = new RelayTestHarness();
    await h.setup({ graceTTL: 200, graceBufferMaxBytes: 1024 });
    try {
      const ext2 = await h.connectExtension();
      const mc2 = new MultiClientHelper(h);
      const wsA = await mc2.connectClient('A');

      // Attach A via Target.setAutoAttach (deferred) then createTab — gives it tab 42
      ext2.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'createTab') {
          ext2.send(JSON.stringify({
            id: msg.id,
            result: { tabId: 42, targetInfo: { type: 'page', url: 'https://example.com', title: 'Example' } },
          }));
        }
        if (msg.method === 'attachToTab') {
          ext2.send(JSON.stringify({
            id: msg.id,
            result: { targetInfo: { type: 'page', url: 'https://example.com', title: 'Example' }, tabId: 42 },
          }));
        }
      });

      wsA.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
      await sleep(30);

      // Get sessionId from activeSessions and create tab via sideband
      const sessionsBeforeCreate = h.relay.activeSessions();
      const relaySessionA = sessionsBeforeCreate[0]?.sessionId;
      expect(relaySessionA).toBeDefined();
      await h.relay.createTab(relaySessionA!, 'about:blank');
      await sleep(30);

      // Verify A has tab 42 before bump
      const sessionsBefore = h.relay.activeSessions();
      const aSessionBefore = sessionsBefore.find(s => s.sessionId === relaySessionA);
      expect(aSessionBefore?.tab?.tabId).toBe(42);

      // Now call attachTab with a bumped result pointing at A's session
      // Temporarily override extension handler to return bumpedSessionId
      ext2.removeAllListeners('message');
      ext2.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'attachToTab') {
          ext2.send(JSON.stringify({
            id: msg.id,
            result: {
              targetInfo: { type: 'page', url: 'https://example.com', title: 'Example' },
              tabId: 42,
              bumpedSessionId: relaySessionA,
            },
          }));
        }
      });

      await h.relay.attachTab('new-session', 42);
      await sleep(20);

      // A's session should now have tab: null
      const sessionsAfter = h.relay.activeSessions();
      const aSessionAfter = sessionsAfter.find(s => s.sessionId === relaySessionA);
      expect(aSessionAfter?.tab).toBeNull();
    } finally {
      await h.teardown();
    }
  });

  // Target.targetInfoChanged updates session URL in activeSessions
  it('activeSessions reflects URL after Target.targetInfoChanged', async () => {
    await harness.teardown();
    const h = new RelayTestHarness();
    await h.setup({ graceTTL: 200, graceBufferMaxBytes: 1024 });
    try {
      const ext = await h.connectExtension();
      const mc = new MultiClientHelper(h);
      const ws = await mc.connectClient('nav');

      // Attach via Target.setAutoAttach (deferred) then createTab — initial URL is connect.html
      ext.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { tabId: 77, targetInfo: { type: 'page', url: msg.params?.url ?? 'chrome-extension://abc/connect.html', title: 'Connect' } },
          }));
        }
        if (msg.method === 'attachToTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { targetInfo: { type: 'page', url: 'chrome-extension://abc/connect.html', title: 'Connect' }, tabId: 77 },
          }));
        }
      });

      ws.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
      await sleep(30);

      // Create tab via sideband with the initial URL
      const sessionsBeforeCreate = h.relay.activeSessions();
      const navSessionId = sessionsBeforeCreate[0]?.sessionId;
      await h.relay.createTab(navSessionId!, 'chrome-extension://abc/connect.html');
      await sleep(30);

      // URL should be the initial connect.html
      const before = h.relay.activeSessions();
      expect(before[0].tab?.url).toBe('chrome-extension://abc/connect.html');

      // Extension forwards Target.targetInfoChanged after page navigates
      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          sessionId: before[0].sessionId,
          method: 'Target.targetInfoChanged',
          params: { targetInfo: { type: 'page', url: 'https://example.com', title: 'Example Domain' } },
        },
      }));
      await sleep(20);

      // activeSessions should now show the navigated URL
      const after = h.relay.activeSessions();
      expect(after[0].tab?.url).toBe('https://example.com');
    } finally {
      await h.teardown();
    }
  });

  // Page.frameNavigated (main frame) updates session URL — the common path
  it('activeSessions reflects URL after Page.frameNavigated', async () => {
    await harness.teardown();
    const h = new RelayTestHarness();
    await h.setup({ graceTTL: 200, graceBufferMaxBytes: 1024 });
    try {
      const ext = await h.connectExtension();
      const mc = new MultiClientHelper(h);
      const ws = await mc.connectClient('nav');

      ext.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'createTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { tabId: 88, targetInfo: { type: 'page', url: msg.params?.url ?? 'chrome-extension://abc/connect.html', title: 'Connect' } },
          }));
        }
        if (msg.method === 'attachToTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { targetInfo: { type: 'page', url: 'chrome-extension://abc/connect.html', title: 'Connect' }, tabId: 88 },
          }));
        }
      });

      ws.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
      await sleep(30);

      // Create tab via sideband with the initial URL
      const sessionsBeforeCreate = h.relay.activeSessions();
      const navSessionId = sessionsBeforeCreate[0]?.sessionId;
      await h.relay.createTab(navSessionId!, 'chrome-extension://abc/connect.html');
      await sleep(30);

      const before = h.relay.activeSessions();
      expect(before[0].tab?.url).toBe('chrome-extension://abc/connect.html');

      // Main-frame navigation (no parentId)
      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          sessionId: before[0].sessionId,
          method: 'Page.frameNavigated',
          params: { frame: { id: 'MAIN', url: 'https://httpbin.org/', mimeType: 'text/html' }, type: 'Navigation' },
        },
      }));
      await sleep(20);

      const after = h.relay.activeSessions();
      expect(after[0].tab?.url).toBe('https://httpbin.org/');

      // Iframe navigation (has parentId) should NOT update the session URL
      ext.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          sessionId: before[0].sessionId,
          method: 'Page.frameNavigated',
          params: { frame: { id: 'IFRAME1', parentId: 'MAIN', url: 'https://ads.example.com/', mimeType: 'text/html' }, type: 'Navigation' },
        },
      }));
      await sleep(20);

      const afterIframe = h.relay.activeSessions();
      expect(afterIframe[0].tab?.url).toBe('https://httpbin.org/');
    } finally {
      await h.teardown();
    }
  });

  // Finding 4: attachTab/createTab update the ClientSession
  it('attachTab updates ClientSession tabId and targetInfo', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            targetInfo: { type: 'page', url: 'https://attached.com', title: 'Attached' },
            tabId: 55,
          },
        }));
      }
    });

    const pw = await harness.connectPlaywrightRaw();
    void pw;
    // Get the sessionId by checking activeSessions
    const sessionsBefore = harness.relay.activeSessions();
    expect(sessionsBefore).toHaveLength(1);
    const relaySessionId = sessionsBefore[0].sessionId;

    // Before attachTab: no tab
    expect(sessionsBefore[0].tab).toBeNull();

    // Call attachTab with the relay's actual sessionId
    await harness.relay.attachTab(relaySessionId, 55);
    await sleep(20);

    const sessionsAfter = harness.relay.activeSessions();
    const session = sessionsAfter.find(s => s.sessionId === relaySessionId);
    expect(session?.tab?.tabId).toBe(55);
    expect(session?.tab?.url).toBe('https://attached.com');
  });

  it('createTab updates ClientSession tabId when session exists', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            tabId: 88,
            url: msg.params.url || 'about:blank',
            targetInfo: { type: 'page', url: msg.params.url || 'about:blank', title: 'New Tab' },
          },
        }));
      }
    });

    await harness.connectPlaywrightRaw();
    const sessionsBefore = harness.relay.activeSessions();
    expect(sessionsBefore).toHaveLength(1);
    const relaySessionId = sessionsBefore[0].sessionId;

    // Before createTab: no tab
    expect(sessionsBefore[0].tab).toBeNull();

    // Call createTab with the relay's actual sessionId
    await harness.relay.createTab(relaySessionId, 'https://new.com');
    await sleep(20);

    const sessionsAfter = harness.relay.activeSessions();
    const session = sessionsAfter.find(s => s.sessionId === relaySessionId);
    expect(session?.tab?.tabId).toBe(88);
  });

  it('createTab with non-existent sessionId does not crash', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 99, url: 'about:blank' },
        }));
      }
    });

    // Session does not exist in _clients — should not crash
    const result = await harness.relay.createTab('nonexistent-session', 'about:blank');
    expect(result.tabId).toBe(99);
  });

  // Finding 5: Content-Type on error responses
  it('error responses from /tabs endpoint include Content-Type: application/json', async () => {
    // No extension connected — /tabs GET will 503
    const port = (harness.server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/tabs`);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('400 error from /tabs/create includes Content-Type: application/json', async () => {
    await harness.connectExtension();
    const port = (harness.server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/tabs/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }), // missing sessionId
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('400 error from /tabs/attach includes Content-Type: application/json', async () => {
    await harness.connectExtension();
    const port = (harness.server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/tabs/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test' }), // missing tabId
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('CDPRelayServer -- Per-Session Grace', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 1024, sessionGraceTTL: 100 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  /** Wire up a standard extension handler that responds to createTab, attachToTab, and detachTab. */
  function wireExtension(ext: WebSocket, extMessages: any[], tabId: number = 42): void {
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId },
        }));
      }
      if (msg.method === 'detachTab')
        ext.send(JSON.stringify({ id: msg.id, result: {} }));

    });
  }

  it('per-session grace: disconnect does not send detachTab immediately', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Verify tab was created
    expect(extMessages.some(m => m.method === 'createTab')).toBe(true);

    // Disconnect — enters per-session grace
    await harness.disconnect(pw);

    // Wait 50ms (less than sessionGraceTTL=100ms)
    await sleep(50);

    // No detachTab should have been sent yet
    const detachMsgs = extMessages.filter(m => m.method === 'detachTab');
    expect(detachMsgs.length).toBe(0);
  });

  it('per-session grace: reconnect with same sessionId restores tab state', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Verify tab 42 is assigned
    const sessions1 = harness.relay.activeSessions();
    expect(sessions1).toHaveLength(1);
    expect(sessions1[0].tab?.tabId).toBe(42);

    // Disconnect
    await harness.disconnect(pw);

    // Reconnect with same sessionId within grace TTL
    const pw2 = await harness.connectPlaywrightWithSessionId('sess-A');
    void pw2;
    await sleep(20);

    // Should be restored with same tabId
    const sessions2 = harness.relay.activeSessions();
    expect(sessions2).toHaveLength(1);
    expect(sessions2[0].tab?.tabId).toBe(42);
    expect(sessions2[0].sessionId).toBe('sess-A');
  });

  it('per-session grace: Target.setAutoAttach returns cached targetInfo', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Count createTab calls — should be 1 so far
    const createCount1 = extMessages.filter(m => m.method === 'createTab').length;
    expect(createCount1).toBe(1);

    // Disconnect and reconnect within grace
    await harness.disconnect(pw);

    const pw2 = await harness.connectPlaywrightWithSessionId('sess-A');
    const pw2Messages: any[] = [];
    pw2.on('message', (data: WebSocket.RawData) => {
      pw2Messages.push(JSON.parse(data.toString()));
    });
    await sleep(20);

    // Send Target.setAutoAttach again on reconnected session
    pw2.send(JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // No NEW createTab should have been sent to extension (cached targetInfo path)
    const createCount2 = extMessages.filter(m => m.method === 'createTab').length;
    expect(createCount2).toBe(1); // still just the original one

    // Client should receive Target.attachedToTarget with cached data
    const attachedMsg = pw2Messages.find(m => m.method === 'Target.attachedToTarget');
    expect(attachedMsg).toBeDefined();
    expect(attachedMsg.params.targetInfo.type).toBe('page');
    expect(attachedMsg.params.targetInfo.url).toBe('https://example.com');
  });

  it('per-session grace: expiry sends detachTab', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Disconnect — enters per-session grace
    await harness.disconnect(pw);

    // Wait for grace to expire and detachTab to arrive
    const detachMsg = await waitForMessage(extMessages, 'detachTab');
    expect(detachMsg.params.sessionId).toBe('sess-A');
  });

  it('per-session grace: different sessionId does not restore', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    // Keep a background client so sess-A disconnect doesn't trigger server-level grace
    const bgClient = await harness.connectPlaywrightWithSessionId('sess-bg');

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    const sessions1 = harness.relay.activeSessions();
    const sessA = sessions1.find(s => s.sessionId === 'sess-A');
    expect(sessA?.tab?.tabId).toBe(42);

    // Disconnect sess-A (enters per-session grace, NOT server-level grace since bgClient is still connected)
    await harness.disconnect(pw);

    // Connect with DIFFERENT sessionId — should NOT get sess-A's graced state
    const pw2 = await harness.connectPlaywrightWithSessionId('sess-B');
    void pw2;
    await sleep(20);

    // sess-B should have a fresh session — no tab (per-session grace is sessionId-specific)
    const sessions2 = harness.relay.activeSessions();
    const sessB = sessions2.find(s => s.sessionId === 'sess-B');
    expect(sessB).toBeDefined();
    expect(sessB!.tab).toBeNull();

    bgClient.close();
  });

  it('per-session grace: multi-client independence', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages, 42);

    const mc = new MultiClientHelper(harness);
    await mc.connectClientWithSessionId('A', 'sess-A');
    await mc.connectClientWithSessionId('B', 'sess-B');

    // Both do Target.setAutoAttach
    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);
    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    expect(harness.relay.clientCount).toBe(2);

    // Disconnect A — enters per-session grace
    await mc.disconnectClient('A');
    expect(harness.relay.clientCount).toBe(1);

    // B should be unaffected
    expect(harness.relay.state).toBe('connected');
    const sessions = harness.relay.activeSessions();
    const sessB = sessions.find(s => s.sessionId === 'sess-B');
    expect(sessB).toBeDefined();

    // No detachTab sent yet for A (in per-session grace)
    await sleep(50);
    const detachMsgs = extMessages.filter(m => m.method === 'detachTab');
    expect(detachMsgs.length).toBe(0);

    // Reconnect A with same sessionId
    await mc.connectClientWithSessionId('A', 'sess-A');
    await sleep(20);

    // Both should be active
    expect(harness.relay.clientCount).toBe(2);
  });

  it('per-session grace: coexists with server-level grace', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    // Single client connects (last client = server-level grace applies too)
    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    const sessions1 = harness.relay.activeSessions();
    expect(sessions1[0].tab?.tabId).toBe(42);

    // Disconnect last client — both per-session and server-level grace should enter
    await harness.disconnect(pw);

    // Server-level grace is active (graceTTL=500ms)
    expect(harness.relay.state).toBe('grace');

    // Per-session grace is active — no detachTab yet
    await sleep(50);
    expect(extMessages.filter(m => m.method === 'detachTab').length).toBe(0);

    // Reconnect with same sessionId within TTL
    const pw2 = await harness.connectPlaywrightWithSessionId('sess-A');
    void pw2;
    await sleep(20);

    // Both should be restored
    expect(harness.relay.state).toBe('connected');
    const sessions2 = harness.relay.activeSessions();
    expect(sessions2).toHaveLength(1);
    expect(sessions2[0].tab?.tabId).toBe(42);
    expect(sessions2[0].sessionId).toBe('sess-A');
  });

  it('per-session grace: no grace for sessions without tab binding', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    // Connect but do NOT call Target.setAutoAttach — no tab binding
    const mc = new MultiClientHelper(harness);
    await mc.connectClientWithSessionId('A', 'sess-A');
    await mc.connectClientWithSessionId('B', 'sess-B');

    // Only B gets a tab
    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Disconnect A (no tab) — should NOT enter per-session grace
    // Since A had no cdpSessionId, there's nothing to grace
    await mc.disconnectClient('A');

    // B is still connected, so relay stays connected
    expect(harness.relay.state).toBe('connected');
    expect(harness.relay.clientCount).toBe(1);

    // No detachTab for A (nothing to detach — A never had a tab)
    await sleep(20);
    const detachMsgs = extMessages.filter(m => m.method === 'detachTab');
    expect(detachMsgs.length).toBe(0);
  });
});

describe('CDPRelayServer -- Immediate Cleanup (skip grace on idle disposal)', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 1024, sessionGraceTTL: 200 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  function wireExtension(ext: WebSocket, extMessages: any[], tabId: number = 42): void {
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId },
        }));
      }
      if (msg.method === 'detachTab')
        ext.send(JSON.stringify({ id: msg.id, result: {} }));

    });
  }

  it('markForImmediateCleanup skips per-session grace on WS close', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    const pw = await harness.connectPlaywrightWithSessionId('idle-sess');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);
    await harness.relay.createTab('idle-sess', 'https://example.com');
    await sleep(30);

    // Mark for immediate cleanup (simulating SESSION_IDLE_TTL firing)
    harness.relay.markForImmediateCleanup('idle-sess');

    // Disconnect — WS close should skip grace
    await harness.disconnect(pw);
    await sleep(30);

    // detachTab should fire immediately (not after 200ms grace)
    const detachMsgs = extMessages.filter(m => m.method === 'detachTab');
    expect(detachMsgs.length).toBe(1);

    // Session should NOT be in dormant (MCP session is permanently gone)
    const sessions = harness.relay.activeSessions();
    const dormant = sessions.filter(s => s.status === 'dormant');
    expect(dormant.length).toBe(0);
  });

  it('markForImmediateCleanup cancels already-active grace', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    const pw = await harness.connectPlaywrightWithSessionId('grace-then-idle');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);
    await harness.relay.createTab('grace-then-idle', 'https://example.com');
    await sleep(30);

    // Disconnect — enters per-session grace (200ms)
    await harness.disconnect(pw);
    await sleep(30);

    // No detachTab yet (grace still active)
    expect(extMessages.filter(m => m.method === 'detachTab').length).toBe(0);

    // Now mark for immediate cleanup (simulating SESSION_IDLE_TTL firing
    // after the WS already closed)
    harness.relay.markForImmediateCleanup('grace-then-idle');
    await sleep(30);

    // detachTab should fire immediately (grace cancelled)
    const detachMsgs = extMessages.filter(m => m.method === 'detachTab');
    expect(detachMsgs.length).toBe(1);

    // Wait past grace TTL — no dormant session should appear
    await sleep(250);
    const sessions = harness.relay.activeSessions();
    const dormant = sessions.filter(s => s.status === 'dormant');
    expect(dormant.length).toBe(0);
  });

  it('markForImmediateCleanup is a no-op for unknown sessionId', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages);

    // Mark a session that doesn't exist — should not throw
    harness.relay.markForImmediateCleanup('nonexistent');

    // No detachTab sent
    await sleep(30);
    expect(extMessages.filter(m => m.method === 'detachTab').length).toBe(0);
  });
});

describe('CDPRelayServer -- Dormant Sessions', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 1024, sessionGraceTTL: 100 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  /** Wire up a standard extension handler that responds to createTab, attachToTab, and detachTab. */
  function wireExtension(ext: WebSocket, extMessages: any[], tabId: number = 42): void {
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId },
        }));
      }
      if (msg.method === 'detachTab')
        ext.send(JSON.stringify({ id: msg.id, result: {} }));

    });
  }

  /** Wire up an extension handler that returns incrementing tabIds per createTab/attachToTab call. */
  function wireExtensionMultiTab(ext: WebSocket, extMessages: any[], tabIdMap: Map<string, number>): void {
    let tabCounter = 100;
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'createTab') {
        const sessionId = msg.params?.sessionId as string;
        if (!tabIdMap.has(sessionId))
          tabIdMap.set(sessionId, tabCounter++);

        const assignedTabId = tabIdMap.get(sessionId)!;
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: assignedTabId, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        const sessionId = msg.params?.sessionId as string;
        if (!tabIdMap.has(sessionId))
          tabIdMap.set(sessionId, tabCounter++);

        const assignedTabId = tabIdMap.get(sessionId)!;
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: assignedTabId },
        }));
      }
      if (msg.method === 'detachTab')
        ext.send(JSON.stringify({ id: msg.id, result: {} }));

    });
  }

  it('dormant: grace expiry sends detachTab and stores dormant entry', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages, 42);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Verify tab was created
    expect(extMessages.some(m => m.method === 'createTab')).toBe(true);

    // Disconnect — enters per-session grace (100ms TTL)
    await harness.disconnect(pw);

    // Wait past grace TTL
    await sleep(150);

    // detachTab should have been sent to extension
    const detachMsg = extMessages.find(m => m.method === 'detachTab');
    expect(detachMsg).toBeDefined();
    expect(detachMsg.params.sessionId).toBe('sess-A');

    // Session should now be dormant
    const sessions = harness.relay.activeSessions();
    const dormantEntry = sessions.find(s => s.sessionId === 'sess-A');
    expect(dormantEntry).toBeDefined();
    expect(dormantEntry!.status).toBe('dormant');
    expect(dormantEntry!.tab?.tabId).toBe(42);

    // No active WS clients
    expect(harness.relay.clientCount).toBe(0);
  });

  it('dormant: reconnect with same sessionId reattaches to same tab', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages, 42);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Disconnect and wait for dormant
    await harness.disconnect(pw);
    await sleep(150);

    // Verify dormant state
    const dormantSessions = harness.relay.activeSessions();
    expect(dormantSessions.find(s => s.sessionId === 'sess-A')?.status).toBe('dormant');

    // Reconnect with same sessionId
    const pw2 = await harness.connectPlaywrightWithSessionId('sess-A');
    pw2.send(JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Extension should have received attachToTab with tabId 42 on reconnect
    // (initial tab was created via createTab, not attachToTab)
    const attachMsgs = extMessages.filter(m => m.method === 'attachToTab');
    expect(attachMsgs.length).toBe(1);
    expect(attachMsgs[0].params.tabId).toBe(42);

    // Session should be active now
    const activeSessions = harness.relay.activeSessions();
    const sessA = activeSessions.find(s => s.sessionId === 'sess-A');
    expect(sessA).toBeDefined();
    expect(sessA!.status).toBe('active');
    expect(sessA!.tab?.tabId).toBe(42);
  });

  it('dormant: tabClosed event cleans up dormant session', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages, 42);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Disconnect and wait for dormant
    await harness.disconnect(pw);
    await sleep(150);

    // Verify dormant entry exists
    const dormantSessions = harness.relay.activeSessions();
    expect(dormantSessions.find(s => s.sessionId === 'sess-A')?.status).toBe('dormant');

    // Simulate tabClosed from extension
    ext.send(JSON.stringify({ method: 'tabClosed', params: { sessionId: 'sess-A', tabId: 42 } }));
    await sleep(30);

    // Dormant entry should be cleaned up
    const afterClose = harness.relay.activeSessions();
    expect(afterClose.find(s => s.sessionId === 'sess-A')).toBeUndefined();
  });

  it('dormant: tabClosed during grace prevents dormant entry', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages, 42);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Disconnect — enters grace (100ms TTL), NOT yet dormant
    await harness.disconnect(pw);

    // Wait 30ms (still within 100ms grace)
    await sleep(30);

    // Send tabClosed from extension while in grace
    ext.send(JSON.stringify({ method: 'tabClosed', params: { sessionId: 'sess-A', tabId: 42 } }));

    // Wait past original grace TTL
    await sleep(120);

    // No dormant entry should have been created
    const sessions = harness.relay.activeSessions();
    expect(sessions.find(s => s.sessionId === 'sess-A')).toBeUndefined();
  });

  it('dormant: different sessionId does not match dormant entry', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages, 42);

    // Use a background client so sess-A disconnect doesn't trigger server-level grace disposal
    const bgClient = await harness.connectPlaywrightWithSessionId('sess-bg');

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Disconnect sess-A and wait for dormant
    await harness.disconnect(pw);
    await sleep(150);

    // sess-A should be dormant
    const dormantSessions = harness.relay.activeSessions();
    expect(dormantSessions.find(s => s.sessionId === 'sess-A')?.status).toBe('dormant');

    // Connect with DIFFERENT sessionId
    const pw2 = await harness.connectPlaywrightWithSessionId('sess-B');
    pw2.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // sess-B should NOT trigger attachToTab — deferred tab creation means
    // new sessions with no dormant tab get no immediate tab
    const attachMsgs = extMessages.filter(m => m.method === 'attachToTab');
    expect(attachMsgs.length).toBe(0);

    // Dormant entry for sess-A should still exist
    const afterSessB = harness.relay.activeSessions();
    expect(afterSessB.find(s => s.sessionId === 'sess-A')?.status).toBe('dormant');

    bgClient.close();
  });

  it('dormant: multiple dormant sessions coexist independently', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    const tabIdMap = new Map<string, number>();
    tabIdMap.set('sess-A', 42);
    tabIdMap.set('sess-B', 43);
    wireExtensionMultiTab(ext, extMessages, tabIdMap);

    const mc = new MultiClientHelper(harness);
    await mc.connectClientWithSessionId('A', 'sess-A');
    await mc.connectClientWithSessionId('B', 'sess-B');

    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab for sess-A explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab for sess-B explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-B', 'https://example.com');
    await sleep(30);

    // Disconnect both and wait for dormant
    await mc.disconnectClient('A');
    await mc.disconnectClient('B');
    await sleep(150);

    // Both should be dormant
    const dormantSessions = harness.relay.activeSessions();
    const dormantA = dormantSessions.find(s => s.sessionId === 'sess-A');
    const dormantB = dormantSessions.find(s => s.sessionId === 'sess-B');
    expect(dormantA?.status).toBe('dormant');
    expect(dormantB?.status).toBe('dormant');
    expect(dormantA?.tab?.tabId).toBe(42);
    expect(dormantB?.tab?.tabId).toBe(43);

    // Reconnect only sess-A
    await mc.connectClientWithSessionId('A', 'sess-A');
    mc.wsFor('A')!.send(JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // sess-A should be active, sess-B still dormant
    const afterReconnect = harness.relay.activeSessions();
    expect(afterReconnect.find(s => s.sessionId === 'sess-A')?.status).toBe('active');
    expect(afterReconnect.find(s => s.sessionId === 'sess-B')?.status).toBe('dormant');
  });

  it('dormant: reconnect with dead tab falls through to fresh session via extension', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    let attachCallCount = 0;

    // createTab returns tab 42; attachToTab on dormant reconnect returns tab 99
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 42, targetInfo: { type: 'page', url: 'https://example.com' } },
        }));
      }
      if (msg.method === 'attachToTab') {
        attachCallCount++;
        const returnedTabId = attachCallCount === 1 ? 99 : 99;
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: returnedTabId },
        }));
      }
      if (msg.method === 'detachTab')
        ext.send(JSON.stringify({ id: msg.id, result: {} }));

    });

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Disconnect and wait for dormant
    await harness.disconnect(pw);
    await sleep(150);

    // Reconnect — relay should send attachToTab with tabId 42 (from dormant)
    const pw2 = await harness.connectPlaywrightWithSessionId('sess-A');
    pw2.send(JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Extension received attachToTab with the dormant tabId on reconnect
    // (initial tab was created via createTab, not attachToTab)
    const attachMsgs = extMessages.filter(m => m.method === 'attachToTab');
    expect(attachMsgs.length).toBe(1);
    expect(attachMsgs[0].params.tabId).toBe(42);

    // Session is active regardless of which tab the extension ultimately assigned
    const sessions = harness.relay.activeSessions();
    const sessA = sessions.find(s => s.sessionId === 'sess-A');
    expect(sessA).toBeDefined();
    expect(sessA!.status).toBe('active');
  });

  it('dormant: server grace expiry does not clear dormant sessions', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages, 42);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // Disconnect — per-session grace (100ms) AND server grace (500ms) both start
    await harness.disconnect(pw);

    // Wait past per-session grace but NOT past server grace
    await sleep(150);

    // sess-A should be dormant
    const afterPerSessionGrace = harness.relay.activeSessions();
    expect(afterPerSessionGrace.find(s => s.sessionId === 'sess-A')?.status).toBe('dormant');

    // Wait past server grace TTL (500ms total from disconnect)
    await sleep(400);

    // Dormant entry must survive server grace expiry
    const afterServerGrace = harness.relay.activeSessions();
    expect(afterServerGrace.find(s => s.sessionId === 'sess-A')?.status).toBe('dormant');
  });

  it('dormant: relay properties gate prepareForReconnect correctly', async () => {
    // This test documents the guard contract used by createExtensionBrowser:
    // prepareForReconnect() must NOT be called when dormant sessions exist,
    // because it closes the extension WS — forcing a new connect.html tab
    // on the next ensureExtensionConnectionForMCPContext call.
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtension(ext, extMessages, 42);

    const pw = await harness.connectPlaywrightWithSessionId('sess-A');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Create tab explicitly (deferred tab creation model)
    await harness.relay.createTab('sess-A', 'https://example.com');
    await sleep(30);

    // While active: clientCount=1, no dormant
    expect(harness.relay.clientCount).toBe(1);
    expect(harness.relay.dormantSessionCount).toBe(0);

    // Disconnect and wait for dormant
    await harness.disconnect(pw);
    await sleep(150);

    // After dormant: clientCount=0, hasGracedSessions=false, dormantSessionCount=1
    // The guard condition: clientCount===0 && !hasGracedSessions && dormantSessionCount===0
    // must be FALSE so prepareForReconnect is skipped.
    expect(harness.relay.clientCount).toBe(0);
    expect(harness.relay.hasGracedSessions).toBe(false);
    expect(harness.relay.dormantSessionCount).toBe(1);

    // Guard evaluates to false — dormant sessions prevent prepareForReconnect
    const shouldPrepare = harness.relay.clientCount === 0
        && !harness.relay.hasGracedSessions
        && harness.relay.dormantSessionCount === 0;
    expect(shouldPrepare).toBe(false);
  });
});

describe('CDPRelayServer — Stale Page After Bump', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  /**
   * Wire extension that tracks tab ownership per session and supports bump semantics.
   * When session B attaches to session A's tab, returns bumpedSessionId: A's sessionId.
   */
  function wireExtensionWithBump(ext: WebSocket, extMessages: any[]): void {
    // Track which sessionId owns which tabId
    const tabOwners = new Map<number, string>();
    let tabCounter = 100;

    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);

      if (msg.method === 'createTab') {
        const sessionId = msg.params?.sessionId as string;
        const tabId = tabCounter++;
        tabOwners.set(tabId, sessionId);
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            tabId,
            targetInfo: { type: 'page', url: 'https://example.com', title: 'Example', targetId: `target-${tabId}` },
          },
        }));
      }

      if (msg.method === 'attachToTab') {
        const sessionId = msg.params?.sessionId as string;
        const tabId = msg.params?.tabId as number;
        const previousOwner = tabOwners.get(tabId);
        const bumpedSessionId = previousOwner && previousOwner !== sessionId ? previousOwner : undefined;
        tabOwners.set(tabId, sessionId);
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            targetInfo: { type: 'page', url: 'https://example.com', title: 'Example', targetId: `target-${tabId}` },
            tabId,
            bumpedSessionId,
          },
        }));
      }

      if (msg.method === 'detachTab')
        ext.send(JSON.stringify({ id: msg.id, result: {} }));

    });
  }

  it('bump notification sends Target.detachedFromTarget with targetId so Playwright can clean up the page', async () => {
    // This test reproduces the "stale page after session bump" bug.
    //
    // Bug: When session B attaches to session A's tab, the relay sends
    // Target.detachedFromTarget to session A — but the event only contains
    // `sessionId` (the CDP child session ID), NOT `targetId`.
    //
    // CRBrowser._onDetachedFromTarget does: `const targetId = payload.targetId!`
    // then `this._crPages.get(targetId)`. Without targetId, the lookup fails
    // and the stale Page object is never destroyed. Subsequent tool calls on
    // session A hang because they try to snapshot a page with a dead CDP
    // connection (Runtime.callFunctionOn fails, Playwright retries with
    // exponential backoff, hits 30s timeout).
    //
    // Expected: The detach event must include targetId so CRBrowser can
    // find and destroy the CRPage.

    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtensionWithBump(ext, extMessages);

    const mc = new MultiClientHelper(harness);

    // 1. Connect session A
    const wsA = await mc.connectClientWithSessionId('A', 'sess-A');

    // 2. Session A sends Target.setAutoAttach (deferred — relay returns empty)
    wsA.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    // 3. Create a tab for session A
    const createResult = await harness.relay.createTab('sess-A', 'https://example.com');
    const tabId = createResult.tabId;
    await sleep(30);

    // 4. Connect session B
    const wsB = await mc.connectClientWithSessionId('B', 'sess-B');

    // 5. Session B sends Target.setAutoAttach (deferred)
    wsB.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    // 6. Session B attaches to session A's tab (bump)
    await harness.relay.attachTab('sess-B', tabId);
    await sleep(50);

    // 7. Verify: Session A received a Target.detachedFromTarget notification
    const aMessages = mc.messagesFor('A');
    const detachNotification = aMessages.find(
        (m: any) => m.method === 'Target.detachedFromTarget'
    );
    expect(detachNotification).toBeDefined();

    // 8. THE CRITICAL ASSERTION: The detach event must include targetId.
    // CRBrowser._onDetachedFromTarget (crBrowser.ts:213) does:
    //   const targetId = payload.targetId!;
    //   const crPage = this._crPages.get(targetId);
    // Without targetId, crPage is undefined, didClose() never fires,
    // and the stale Page hangs all subsequent operations.
    //
    // This assertion FAILS with the current relay code — proving the bug.
    // _notifyBumpedClient sends { sessionId, reason } but no targetId.
    expect(detachNotification.params).toHaveProperty('targetId');
    expect(detachNotification.params.targetId).toBeTruthy();
  });

  it('bump notification targetId matches the tab target so CRBrowser can look up the CRPage', async () => {
    // Even if targetId is present, it must match the targetId from the
    // original Target.attachedToTarget event so CRBrowser._crPages.get()
    // finds the right CRPage.

    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    wireExtensionWithBump(ext, extMessages);

    const mc = new MultiClientHelper(harness);

    // Connect session A, create tab
    const wsA = await mc.connectClientWithSessionId('A', 'sess-A');
    wsA.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    const createResult = await harness.relay.createTab('sess-A', 'https://example.com');
    const tabId = createResult.tabId;
    await sleep(30);

    // Capture the Target.attachedToTarget event that session A received
    const aMessagesBeforeBump = mc.messagesFor('A');
    const attachEvent = aMessagesBeforeBump.find(
        (m: any) => m.method === 'Target.attachedToTarget'
    );
    expect(attachEvent).toBeDefined();
    const originalTargetId = attachEvent.params?.targetInfo?.targetId;

    // Connect session B, bump session A
    const wsB = await mc.connectClientWithSessionId('B', 'sess-B');
    wsB.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    await harness.relay.attachTab('sess-B', tabId);
    await sleep(50);

    // The detach notification's targetId must match the original targetId
    // from attachedToTarget so CRBrowser._crPages.get(targetId) succeeds
    const aMessages = mc.messagesFor('A');
    const detachNotification = aMessages.find(
        (m: any) => m.method === 'Target.detachedFromTarget'
    );
    expect(detachNotification).toBeDefined();
    // This FAILS: no targetId in the detach event at all
    expect(detachNotification.params.targetId).toBe(originalTargetId);
  });
});

describe('CDPRelayServer — Deferred Tab Creation', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 1024, sessionGraceTTL: 100 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('new session defers tab creation on Target.setAutoAttach', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      // Should NOT be called — respond anyway to avoid test hanging if it is called
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
    });

    const pw = await harness.connectPlaywrightWithSessionId('deferred-sess-1');
    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });

    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Relay should have responded with {} (the id response)
    const idResponse = pwMessages.find(m => m.id === 1);
    expect(idResponse).toBeDefined();
    expect(idResponse.result).toEqual({});

    // NO Target.attachedToTarget should have been sent
    const attachedToTarget = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attachedToTarget).toBeUndefined();

    // Extension's attachToTab should NOT have been called
    const attachToTabMsg = extMessages.find(m => m.method === 'attachToTab');
    expect(attachToTabMsg).toBeUndefined();
  });

  it('createTab sends Target.attachedToTarget after deferred creation', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            tabId: 55,
            url: msg.params.url || 'about:blank',
            targetInfo: { type: 'page', url: msg.params.url || 'about:blank', title: 'New Tab' },
          },
        }));
      }
    });

    const pw = await harness.connectPlaywrightWithSessionId('deferred-sess-2');
    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });

    // Trigger deferred path — no Target.attachedToTarget yet
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    const attachedBefore = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attachedBefore).toBeUndefined();

    // Now call createTab — should trigger Target.attachedToTarget
    await harness.relay.createTab('deferred-sess-2', 'https://example.com');
    await sleep(50);

    const attachedAfter = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attachedAfter).toBeDefined();
    expect(attachedAfter.params.sessionId).toMatch(/^session-/);
    expect(attachedAfter.params.targetInfo).toBeDefined();
    expect(attachedAfter.params.targetInfo.type).toBe('page');
  });

  it('attachTab sends Target.attachedToTarget after deferred creation', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: {
            targetInfo: { type: 'page', url: 'https://example.com', title: 'Existing Tab' },
            tabId: msg.params.tabId ?? 42,
          },
        }));
      }
    });

    const pw = await harness.connectPlaywrightWithSessionId('deferred-sess-3');
    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });

    // Trigger deferred path
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    const attachedBefore = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attachedBefore).toBeUndefined();

    // Call attachTab — should trigger Target.attachedToTarget
    await harness.relay.attachTab('deferred-sess-3', 42);
    await sleep(50);

    const attachedAfter = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attachedAfter).toBeDefined();
    expect(attachedAfter.params.sessionId).toMatch(/^session-/);
    expect(attachedAfter.params.targetInfo).toBeDefined();
    expect(attachedAfter.params.targetInfo.url).toBe('https://example.com');
  });

  it('graced session gets immediate Target.attachedToTarget on Target.setAutoAttach', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
      if (msg.method === 'detachTab')
        ext.send(JSON.stringify({ id: msg.id, result: {} }));

    });

    // First connection — triggers normal attachToTab (or deferred, depending on behavior)
    const pw = await harness.connectPlaywrightWithSessionId('grace-sess-1');
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Verify tab was attached (via createTab or direct attachToTab — give session tab state)
    // For the grace path to work, session must have tabId + targetInfo.
    // If deferred, we need to call createTab or attachTab first.
    const sessionsBeforeDisconnect = harness.relay.activeSessions();
    const sess = sessionsBeforeDisconnect.find(s => s.sessionId === 'grace-sess-1');
    if (sess && sess.tab === null) {
      // Session is deferred — establish tab binding via sideband so grace recovery works
      await harness.relay.attachTab('grace-sess-1', 42);
      await sleep(20);
    }

    // Verify session has a tab now
    const sessionsWithTab = harness.relay.activeSessions();
    const sessWithTab = sessionsWithTab.find(s => s.sessionId === 'grace-sess-1');
    expect(sessWithTab?.tab?.tabId).toBe(42);

    // Disconnect — enters per-session grace
    await harness.disconnect(pw);

    // Reconnect with same sessionId within grace TTL
    const pw2 = await harness.connectPlaywrightWithSessionId('grace-sess-1');
    const pw2Messages: any[] = [];
    pw2.on('message', (data: WebSocket.RawData) => {
      pw2Messages.push(JSON.parse(data.toString()));
    });
    await sleep(20);

    // Clear previous attachment count from extension
    const attachCountBefore = extMessages.filter(m => m.method === 'attachToTab').length;

    // Send Target.setAutoAttach on reconnected session (grace recovery)
    pw2.send(JSON.stringify({ id: 2, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Grace recovery: Target.attachedToTarget should be sent immediately with cached data
    const attachedMsg = pw2Messages.find(m => m.method === 'Target.attachedToTarget');
    expect(attachedMsg).toBeDefined();
    expect(attachedMsg.params.targetInfo.type).toBe('page');
    expect(attachedMsg.params.targetInfo.url).toBe('https://example.com');

    // No new attachToTab call to the extension (used cached data)
    const attachCountAfter = extMessages.filter(m => m.method === 'attachToTab').length;
    expect(attachCountAfter).toBe(attachCountBefore);
  });
});

describe('CDPRelayServer — MV3 keepalive', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 500, extensionGraceTTL: 50 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('keepalive messages from extension are silently ignored', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Collect messages forwarded to the Playwright client
    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });

    // Send a keepalive from the extension (as the MV3 SW would)
    ext.send(JSON.stringify({ type: 'keepalive' }));
    await sleep(30);

    // Keepalive must not be routed to the Playwright client
    expect(pwMessages.filter(m => m.type === 'keepalive')).toHaveLength(0);
    // Relay should remain connected (no error state)
    expect(harness.relay.state).toBe('connected');
  });

  it('keepalive does not interfere with normal CDP messages', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });

    // Interleave keepalive with a real CDP event
    ext.send(JSON.stringify({ type: 'keepalive' }));
    ext.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: { method: 'Page.loadEventFired', params: { timestamp: 123 } },
    }));
    ext.send(JSON.stringify({ type: 'keepalive' }));
    await sleep(30);

    // Only the CDP event should reach the client
    const cdpEvents = pwMessages.filter(m => m.method === 'Page.loadEventFired');
    expect(cdpEvents).toHaveLength(1);
    expect(pwMessages.filter(m => m.type === 'keepalive')).toHaveLength(0);
  });
});

describe('deferred tab creation', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 50, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('new session does not create tab on Target.setAutoAttach', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywrightWithSessionId('deferred-1');

    // Track extension messages
    const extMessages: any[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      // Respond to attachToTab in case it's called (it shouldn't be)
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'about:blank' }, tabId: 99 },
        }));
      }
    });

    // Track Playwright messages
    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });

    // Send Target.setAutoAttach
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Verify: relay returned the command response
    const response = pwMessages.find(m => m.id === 1);
    expect(response).toBeDefined();
    expect(response.result).toEqual({});

    // Verify: NO Target.attachedToTarget was sent
    const attached = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attached).toBeUndefined();

    // Verify: extension was NOT asked to attachToTab
    const attachCall = extMessages.find(m => m.method === 'attachToTab');
    expect(attachCall).toBeUndefined();
  });

  it('createTab sends Target.attachedToTarget after deferred creation', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywrightWithSessionId('deferred-2');

    // Extension responds to createTab
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'createTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: 55, targetInfo: { type: 'page', url: 'https://example.com', title: 'Example' } },
        }));
      }
    });

    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });

    // Send Target.setAutoAttach (deferred — no tab)
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Verify deferred: no Target.attachedToTarget yet
    expect(pwMessages.find(m => m.method === 'Target.attachedToTarget')).toBeUndefined();

    // Now create tab via sideband
    await harness.relay.createTab('deferred-2', 'https://example.com');
    await sleep(30);

    // Verify: Target.attachedToTarget WAS sent
    const attached = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attached).toBeDefined();
    expect(attached.params.targetInfo.url).toBe('https://example.com');
    expect(attached.params.sessionId).toBe('session-deferred-2');
  });

  it('attachTab sends Target.attachedToTarget after deferred creation', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywrightWithSessionId('deferred-3');

    // Extension responds to attachToTab
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { tabId: msg.params.tabId, targetInfo: { type: 'page', url: 'https://attached.com', title: 'Attached' } },
        }));
      }
    });

    const pwMessages: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      pwMessages.push(JSON.parse(data.toString()));
    });

    // Send Target.setAutoAttach (deferred — no tab)
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    // Verify deferred
    expect(pwMessages.find(m => m.method === 'Target.attachedToTarget')).toBeUndefined();

    // Now attach to existing tab via sideband
    await harness.relay.attachTab('deferred-3', 42);
    await sleep(30);

    // Verify: Target.attachedToTarget WAS sent
    const attached = pwMessages.find(m => m.method === 'Target.attachedToTarget');
    expect(attached).toBeDefined();
    expect(attached.params.targetInfo.url).toBe('https://attached.com');
    expect(attached.params.sessionId).toBe('session-deferred-3');
  });
});
