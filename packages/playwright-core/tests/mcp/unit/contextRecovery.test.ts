import http from 'http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';

// Import from compiled playwright-core (file: dependency, vitest alias)
import { CDPRelayServer } from 'playwright-core/src/mcp/cdpRelay';
import type { CDPRelayOptions } from 'playwright-core/src/mcp/cdpRelay';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Test harness for context recovery after debugger reattach.
 * Provides Playwright WS client and extension WS client connected to a relay.
 */
class RecoveryTestHarness {
  server!: http.Server;
  relay!: CDPRelayServer;
  private _playwrightWs: WebSocket | null = null;
  private _extensionWs: WebSocket | null = null;

  async setup(options: CDPRelayOptions = { graceTTL: 500 }) {
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

  async connectExtension(): Promise<WebSocket> {
    const ws = new WebSocket(this.relay.extensionEndpoint());
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    this._extensionWs = ws;
    return ws;
  }

  async connectPlaywrightWithSessionId(sessionId: string): Promise<WebSocket> {
    const ws = new WebSocket(`${this.relay.cdpEndpoint()}?sessionId=${sessionId}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    this._playwrightWs = ws;
    return ws;
  }

  /** Collect all JSON messages received on a WebSocket. */
  collectMessages(ws: WebSocket): any[] {
    const messages: any[] = [];
    ws.on('message', (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()));
    });
    return messages;
  }
}

/**
 * Helper to establish a connected session with a tabId.
 * Simulates the full createTab + Target.setAutoAttach flow so the relay
 * knows the session's tabId and cdpSessionId.
 */
async function setupConnectedSession(
  harness: RecoveryTestHarness,
  sessionId: string,
  tabId: number = 42,
): Promise<{ ext: WebSocket; pw: WebSocket; pwMessages: any[]; extMessages: any[] }> {
  const ext = await harness.connectExtension();
  const pw = await harness.connectPlaywrightWithSessionId(sessionId);
  const pwMessages = harness.collectMessages(pw);
  const extMessages = harness.collectMessages(ext);

  // Auto-respond to extension commands (createTab, attachToTab)
  ext.on('message', (data: WebSocket.RawData) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'createTab') {
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId,
          targetInfo: { type: 'page', url: 'https://example.com', targetId: 'target-1' },
          cdpSessionId: `session-${sessionId}`,
        },
      }));
    }
    if (msg.method === 'attachToTab') {
      ext.send(JSON.stringify({
        id: msg.id,
        result: {
          tabId,
          targetInfo: { type: 'page', url: 'https://example.com', targetId: 'target-1' },
          cdpSessionId: `session-${sessionId}`,
        },
      }));
    }
  });

  // Send Target.setAutoAttach (deferred) then createTab
  pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
  await sleep(30);
  await harness.relay.createTab(sessionId, 'https://example.com');
  await sleep(30);

  return { ext, pw, pwMessages, extMessages };
}

describe('Context recovery after debugger reattach', () => {
  let harness: RecoveryTestHarness;

  beforeEach(async () => {
    harness = new RecoveryTestHarness();
    await harness.setup({ graceTTL: 500, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('relay forwards debuggerReattached to the correct Playwright WS client', async () => {
    const sessionId = 'test-reattach-1';
    const tabId = 42;
    const { ext, pw: pw, pwMessages } = await setupConnectedSession(harness, sessionId, tabId);
    void pw;

    // Extension sends debuggerReattached event
    ext.send(JSON.stringify({
      method: 'debuggerReattached',
      params: { tabId, sessionId },
    }));
    await sleep(30);

    // Playwright client should receive the event with cdpSessionId routing
    const reattachMsg = pwMessages.find(m => m.method === 'debuggerReattached');
    expect(reattachMsg).toBeDefined();
    expect(reattachMsg.params.tabId).toBe(tabId);
    expect(reattachMsg.params.sessionId).toBe(sessionId);
    // The message should be routed via the session's cdpSessionId
    expect(reattachMsg.sessionId).toBe(`session-${sessionId}`);
  });

  it('relay drops debuggerReattached for unknown sessionId', async () => {
    const sessionId = 'test-reattach-2';
    const tabId = 42;
    const { ext, pw: pw, pwMessages } = await setupConnectedSession(harness, sessionId, tabId);
    void pw;

    // Extension sends debuggerReattached for a session that doesn't exist
    ext.send(JSON.stringify({
      method: 'debuggerReattached',
      params: { tabId: 99, sessionId: 'nonexistent-session' },
    }));
    await sleep(30);

    // Playwright client should NOT receive the event (it's for a different session)
    const reattachMsg = pwMessages.find(m => m.method === 'debuggerReattached');
    expect(reattachMsg).toBeUndefined();
  });

  it('relay forwards contextRecoveryComplete from Playwright to extension', async () => {
    const sessionId = 'test-recovery-complete';
    const tabId = 42;
    const { ext: ext, pw, pwMessages: pwMessages, extMessages } = await setupConnectedSession(harness, sessionId, tabId);
    void pwMessages;
    void ext;

    // Playwright sends contextRecoveryComplete back to relay
    pw.send(JSON.stringify({
      method: 'contextRecoveryComplete',
      params: { sessionId },
    }));
    await sleep(30);

    // Extension should receive contextRecoveryComplete with tabId
    const recoveryMsg = extMessages.find(m => m.method === 'contextRecoveryComplete');
    expect(recoveryMsg).toBeDefined();
    expect(recoveryMsg.params.tabId).toBe(tabId);
  });

  it('relay drops contextRecoveryComplete when session has no tabId', async () => {
    // Connect without setting up a tab (no createTab)
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywrightWithSessionId('no-tab-session');
    const extMessages = harness.collectMessages(ext);

    await sleep(30);

    // Playwright sends contextRecoveryComplete for a session without a tab
    pw.send(JSON.stringify({
      method: 'contextRecoveryComplete',
      params: { sessionId: 'no-tab-session' },
    }));
    await sleep(30);

    // Extension should NOT receive contextRecoveryComplete
    const recoveryMsg = extMessages.find(m => m.method === 'contextRecoveryComplete');
    expect(recoveryMsg).toBeUndefined();
  });

  it('contextRecoveryComplete is not forwarded as a CDP command', async () => {
    const sessionId = 'test-no-cdp-forward';
    const tabId = 42;
    const { ext, pw, pwMessages: pwMessages, extMessages: extMessages } = await setupConnectedSession(harness, sessionId, tabId);
    void extMessages;
    void pwMessages;

    // Track if the extension receives any forwardCDPCommand with contextRecoveryComplete
    const cdpCommands: any[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'forwardCDPCommand' && msg.params?.method === 'contextRecoveryComplete')
        cdpCommands.push(msg);
    });

    // Playwright sends contextRecoveryComplete
    pw.send(JSON.stringify({
      method: 'contextRecoveryComplete',
      params: { sessionId },
    }));
    await sleep(30);

    // contextRecoveryComplete should be intercepted by relay, NOT forwarded as CDP
    expect(cdpCommands).toHaveLength(0);
  });

  it('debuggerReattached followed by contextRecoveryComplete round-trip', async () => {
    const sessionId = 'test-roundtrip';
    const tabId = 42;
    const { ext, pw, pwMessages, extMessages } = await setupConnectedSession(harness, sessionId, tabId);

    // Step 1: Extension sends debuggerReattached
    ext.send(JSON.stringify({
      method: 'debuggerReattached',
      params: { tabId, sessionId },
    }));
    await sleep(30);

    // Verify Playwright received it
    const reattachMsg = pwMessages.find(m => m.method === 'debuggerReattached');
    expect(reattachMsg).toBeDefined();

    // Step 2: Playwright responds with contextRecoveryComplete
    pw.send(JSON.stringify({
      method: 'contextRecoveryComplete',
      params: { sessionId },
    }));
    await sleep(30);

    // Verify extension received it
    const recoveryMsg = extMessages.find(m => m.method === 'contextRecoveryComplete');
    expect(recoveryMsg).toBeDefined();
    expect(recoveryMsg.params.tabId).toBe(tabId);
  });

});
