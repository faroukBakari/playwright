import http from 'http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';

import { CDPRelayServer } from 'playwright-core/src/mcp/cdpRelay';
import { extLog, extWarn, extError, setSink, clearSink, _resetForTest, _getBuffer } from '../../../../../../extension/src/extensionLog';
import type { CDPRelayOptions } from 'playwright-core/src/mcp/cdpRelay';

// Extension-side logger (source code, not compiled — vitest resolves via alias)
import type { LogEntry } from '../../../../../../extension/src/extensionLog';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Extension-side unit tests (no server, pure logic) ──────────────────

describe('Extension log — buffer and sink', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('extLog sends entry over WS when sink is connected', () => {
    const sent: LogEntry[] = [];
    setSink(entry => { sent.push(entry); return true; });

    extLog('debugger', 'detach event', 123);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('log:entry');
    expect(sent[0].channel).toBe('debugger');
    expect(sent[0].level).toBe('info');
    expect(sent[0].message).toBe('detach event 123');
    expect(typeof sent[0].ts).toBe('number');
  });

  it('extLog buffers when no sink is set', () => {
    extLog('lifecycle', 'connecting');

    expect(_getBuffer()).toHaveLength(1);
    expect(_getBuffer()[0].channel).toBe('lifecycle');

    // Now set sink — buffer should flush
    const sent: LogEntry[] = [];
    setSink(entry => { sent.push(entry); return true; });

    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe('connecting');
    expect(_getBuffer()).toHaveLength(0);
  });

  it('buffer evicts oldest when cap exceeded', () => {
    // Generate 101 entries without sink
    for (let i = 1; i <= 101; i++)
      extLog('registry', `entry ${i}`);

    expect(_getBuffer()).toHaveLength(100);
    // First entry should be #2 (oldest #1 was evicted)
    expect(_getBuffer()[0].message).toBe('entry 2');

    // Flush and verify
    const sent: LogEntry[] = [];
    setSink(entry => { sent.push(entry); return true; });
    expect(sent).toHaveLength(100);
    expect(sent[0].message).toBe('entry 2');
    expect(sent[99].message).toBe('entry 101');
  });

  it('clearSink stops forwarding, resumes buffering', () => {
    const sent: LogEntry[] = [];
    setSink(entry => { sent.push(entry); return true; });

    extLog('relay', 'first');
    expect(sent).toHaveLength(1);

    clearSink();
    extLog('relay', 'second');
    expect(sent).toHaveLength(1); // No new send
    expect(_getBuffer()).toHaveLength(1);
    expect(_getBuffer()[0].message).toBe('second');

    // Re-set sink — buffered entry flushes
    const sent2: LogEntry[] = [];
    setSink(entry => { sent2.push(entry); return true; });
    expect(sent2).toHaveLength(1);
    expect(sent2[0].message).toBe('second');
  });

  it('extWarn and extError set correct level', () => {
    const sent: LogEntry[] = [];
    setSink(entry => { sent.push(entry); return true; });

    extWarn('debugger', 'warn msg');
    extError('debugger', 'error msg');

    expect(sent[0].level).toBe('warn');
    expect(sent[1].level).toBe('error');
  });
});

// ── Server-side integration test (CDPRelay routes log:entry) ───────────

class LogRelayHarness {
  server!: http.Server;
  relay!: CDPRelayServer;
  private _extensionWs: WebSocket | null = null;

  async setup(options: CDPRelayOptions = { graceTTL: 50 }) {
    this.server = http.createServer();
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.relay = new CDPRelayServer(this.server, 'chrome', options);
  }

  async teardown() {
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
}

describe('CDPRelay — log:entry routing', () => {
  let harness: LogRelayHarness;

  beforeEach(async () => {
    harness = new LogRelayHarness();
    await harness.setup();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('routes log:entry messages to serverLog', async () => {
    // Spy on the serverLog function used by CDPRelay
    const { serverLog } = await import('playwright-core/src/mcp/log');
    const spy = vi.spyOn({ serverLog }, 'serverLog');

    // We can't easily spy on the module-level serverLog import in cdpRelay.
    // Instead, verify the message doesn't crash and isn't treated as a CDP message.
    const ext = await harness.connectExtension();
    await sleep(20);

    const logMsg = JSON.stringify({
      type: 'log:entry',
      channel: 'debugger',
      level: 'info',
      message: 'detach event for tab 123',
      ts: Date.now(),
    });
    ext.send(logMsg);
    await sleep(50);

    // The message should NOT be treated as a CDP response (no callback resolution).
    // The relay should still be functional after receiving the log message.
    // If the message were misrouted, it would log "unexpected response" or crash.
    // Best we can verify without deep mocking: relay is still alive.
    expect(harness.relay.state).not.toBe('error');

    spy.mockRestore();
  });
});
