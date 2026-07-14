/**
 * Tests for browser death recovery.
 *
 * Group 1: server.ts backend reset via in-band error detection
 *   BrowserServerBackend.callTool catches all errors and returns
 *   { isError: true } — it never throws. server.ts inspects the returned
 *   result for browser-death patterns and resets backendPromise so the
 *   next call creates a fresh backend.
 *
 * Group 2: extension-mode browser re-creation (program.ts level)
 *   Tests the browser latch reset pattern — independent of server.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

import { installHttpTransport } from 'playwright-core/src/mcp/sdk/http';
import { createHttpServer, startHttpServer } from 'playwright-core/src/server/utils/network';
import { CDPRelayServer } from 'playwright-core/src/mcp/cdpRelay';

import type { ServerBackendFactory } from 'playwright-core/src/mcp/sdk/server';

// --- HTTP helpers ---

async function mcpPost(port: number, body: object, sessionId?: string): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      method: 'POST',
      path: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseResponse(rawBody: string): any {
  try {
    return JSON.parse(rawBody);
  } catch {
    for (const line of rawBody.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.id !== undefined)
            return parsed;
        } catch { /* try next line */ }
      }
    }
    throw new Error('Cannot parse JSON-RPC response:\n' + rawBody);
  }
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

function callToolBody(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'test_tool', arguments: {} },
  };
}

// --- Controllable mock factory ---
//
// Mirrors real BrowserServerBackend behavior: callTool RETURNS errors
// as { isError: true } results, never throws. This is the MCP protocol
// contract — tool errors are in-band.

interface BackendControl {
  /** Set to make the next callTool return an error result, then auto-clears. */
  nextErrorText: string | null;
  /** How many times factory.create was called. */
  createCount: number;
  /** How many backends were disposed. */
  disposeCount: number;
}

function createControllableFactory(control: BackendControl): ServerBackendFactory {
  return {
    name: 'test',
    nameInConfig: 'test',
    version: '1.0.0',
    toolSchemas: [],
    create: async () => {
      control.createCount++;
      return {
        callTool: async () => {
          if (control.nextErrorText) {
            const text = control.nextErrorText;
            control.nextErrorText = null;
            return {
              content: [{ type: 'text' as const, text: `### Error\n${text}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        },
        dispose: async () => { control.disposeCount++; },
      };
    },
    disposed: async () => {},
  };
}

// --- Setup / teardown ---

let tmpDir: string;
let origCwd: string;
const httpServers: http.Server[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-death-'));
  fs.mkdirSync(path.join(tmpDir, '.local'), { recursive: true });
  origCwd = process.cwd();
  process.chdir(tmpDir);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  process.chdir(origCwd);
  await Promise.all(httpServers.map(s => new Promise<void>(r => s.close(() => r()))));
  httpServers.length = 0;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function startServer(factory: ServerBackendFactory): Promise<{ server: http.Server; port: number }> {
  const server = createHttpServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  await installHttpTransport(server, factory, ['*']);
  httpServers.push(server);
  return { server, port };
}

async function initSession(port: number): Promise<string> {
  const res = await mcpPost(port, INIT_BODY);
  expect(res.status).toBe(200);
  const sessionId = res.headers['mcp-session-id'] as string;
  expect(sessionId).toBeTruthy();
  return sessionId;
}

// ===================================================================
// Group 1: in-band browser-death detection + backend reset
// ===================================================================

describe('backend reset on browser death (in-band detection)', () => {

  it('resets backend when callTool returns "has been closed" error', async () => {
    const control: BackendControl = { nextErrorText: null, createCount: 0, disposeCount: 0 };
    const factory = createControllableFactory(control);
    const { port } = await startServer(factory);
    const sessionId = await initSession(port);

    // First tool call — triggers lazy backend creation
    const res1 = await mcpPost(port, callToolBody(2), sessionId);
    const r1 = parseResponse(res1.body);
    expect(r1.result?.isError).toBeFalsy();
    expect(control.createCount).toBe(1);

    // Inject browser-death error (returned in-band, not thrown)
    control.nextErrorText = 'Error: object.handle: Target page, context or browser has been closed';
    const res2 = await mcpPost(port, callToolBody(3), sessionId);
    const r2 = parseResponse(res2.body);
    expect(r2.result?.isError).toBe(true);

    // Recovery: next call should create a NEW backend
    const res3 = await mcpPost(port, callToolBody(4), sessionId);
    const r3 = parseResponse(res3.body);
    expect(r3.result?.isError).toBeFalsy();
    expect(control.createCount).toBe(2);
  });

  it('resets backend when callTool returns "browser has been disconnected" error', async () => {
    const control: BackendControl = { nextErrorText: null, createCount: 0, disposeCount: 0 };
    const factory = createControllableFactory(control);
    const { port } = await startServer(factory);
    const sessionId = await initSession(port);

    await mcpPost(port, callToolBody(2), sessionId);
    expect(control.createCount).toBe(1);

    control.nextErrorText = 'Error: browser has been disconnected';
    await mcpPost(port, callToolBody(3), sessionId);

    // Recovery call — new backend
    const res3 = await mcpPost(port, callToolBody(4), sessionId);
    const r3 = parseResponse(res3.body);
    expect(r3.result?.isError).toBeFalsy();
    expect(control.createCount).toBe(2);
  });

  it('does NOT reset backend on unrelated errors', async () => {
    const control: BackendControl = { nextErrorText: null, createCount: 0, disposeCount: 0 };
    const factory = createControllableFactory(control);
    const { port } = await startServer(factory);
    const sessionId = await initSession(port);

    await mcpPost(port, callToolBody(2), sessionId);
    expect(control.createCount).toBe(1);

    control.nextErrorText = 'some random error';
    await mcpPost(port, callToolBody(3), sessionId);

    // Next call reuses existing backend — no reset
    const res3 = await mcpPost(port, callToolBody(4), sessionId);
    const r3 = parseResponse(res3.body);
    expect(r3.result?.isError).toBeFalsy();
    expect(control.createCount).toBe(1);
  });

  it('disposes the dead backend before resetting', async () => {
    const control: BackendControl = { nextErrorText: null, createCount: 0, disposeCount: 0 };
    const factory = createControllableFactory(control);
    const { port } = await startServer(factory);
    const sessionId = await initSession(port);

    await mcpPost(port, callToolBody(2), sessionId);

    control.nextErrorText = 'Error: Target page, context or browser has been closed';
    await mcpPost(port, callToolBody(3), sessionId);

    expect(control.disposeCount).toBe(1);
  });

  it('concurrent tool calls after reset share the same new backend', async () => {
    const control: BackendControl = { nextErrorText: null, createCount: 0, disposeCount: 0 };
    const factory = createControllableFactory(control);
    const { port } = await startServer(factory);
    const sessionId = await initSession(port);

    await mcpPost(port, callToolBody(2), sessionId);
    expect(control.createCount).toBe(1);

    control.nextErrorText = 'Error: Target page, context or browser has been closed';
    await mcpPost(port, callToolBody(3), sessionId);

    // Fire 3 concurrent tool calls — all should share one new backend
    const [r1, r2, r3] = await Promise.all([
      mcpPost(port, callToolBody(4), sessionId),
      mcpPost(port, callToolBody(5), sessionId),
      mcpPost(port, callToolBody(6), sessionId),
    ]);

    for (const r of [r1, r2, r3]) {
      const parsed = parseResponse(r.body);
      expect(parsed.result?.isError).toBeFalsy();
    }

    expect(control.createCount).toBe(2);
  });
});

// ===================================================================
// Group 2: extension-mode browser re-creation (program.ts level)
// ===================================================================

class FakeBrowser extends EventEmitter {
  readonly id: string;
  constructor(id: string) {
    super();
    this.id = id;
  }
  contexts() {
    return [{ id: `ctx-${this.id}` }];
  }
}

describe('extension-mode browser re-creation', () => {

  it('factory.create returns fresh context after browser disconnect', async () => {
    let createCount = 0;
    let browserPromise: Promise<FakeBrowser> | null = null;
    const browsers: FakeBrowser[] = [];

    async function createBrowser(): Promise<FakeBrowser> {
      const b = new FakeBrowser(`browser-${++createCount}`);
      browsers.push(b);
      return b;
    }

    function getOrCreateBrowser(): Promise<FakeBrowser> {
      if (!browserPromise) {
        browserPromise = createBrowser().then(browser => {
          browser.on('disconnected', () => { browserPromise = null; });
          return browser;
        }).catch(e => { browserPromise = null; throw e; });
      }
      return browserPromise;
    }

    const factoryCreate = async () => {
      const browser = await getOrCreateBrowser();
      return browser.contexts()[0];
    };

    const ctx1 = await factoryCreate();
    expect(ctx1.id).toBe('ctx-browser-1');
    expect(createCount).toBe(1);

    browsers[0].emit('disconnected');

    const ctx2 = await factoryCreate();
    expect(ctx2.id).toBe('ctx-browser-2');
    expect(createCount).toBe(2);
  });

  it('full cycle: tool call → browser death → error → new tool call → fresh browser', async () => {
    let browserCreateCount = 0;
    let browserPromise: Promise<FakeBrowser> | null = null;
    const browsers: FakeBrowser[] = [];

    async function createBrowserImpl(): Promise<FakeBrowser> {
      const b = new FakeBrowser(`browser-${++browserCreateCount}`);
      browsers.push(b);
      return b;
    }

    function getOrCreateBrowser(): Promise<FakeBrowser> {
      if (!browserPromise) {
        browserPromise = createBrowserImpl().then(browser => {
          browser.on('disconnected', () => { browserPromise = null; });
          return browser;
        }).catch(e => { browserPromise = null; throw e; });
      }
      return browserPromise;
    }

    let factoryCreateCount = 0;
    const factory: ServerBackendFactory = {
      name: 'test',
      nameInConfig: 'test',
      version: '1.0.0',
      toolSchemas: [],
      create: async () => {
        factoryCreateCount++;
        const browser = await getOrCreateBrowser();
        return {
          callTool: async () => {
            // Mirrors BrowserServerBackend: returns error in-band
            return {
              content: [{ type: 'text' as const, text: `ok from ${browser.id}` }],
            };
          },
          dispose: async () => {},
        };
      },
      disposed: async () => {},
    };

    // Validate the latch pattern directly
    const backend1 = await factory.create({ cwd: '/tmp' });
    expect(factoryCreateCount).toBe(1);
    expect(browserCreateCount).toBe(1);

    const r1 = await backend1.callTool('any', {}, () => {});
    expect(r1.isError).toBeFalsy();

    // Browser dies — latch resets
    browsers[0].emit('disconnected');

    // New factory.create → fresh browser
    const backend2 = await factory.create({ cwd: '/tmp' });
    expect(factoryCreateCount).toBe(2);
    expect(browserCreateCount).toBe(2);

    const r2 = await backend2.callTool('any', {}, () => {});
    expect(r2.isError).toBeFalsy();
  });
});

// ===================================================================
// Group 3: CDPRelay respawn (no orphaned servers)
// ===================================================================

describe('CDPRelay respawn (no orphaned servers)', () => {
  const relayServers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(relayServers.map(s => new Promise<void>(r => s.close(() => r()))));
    relayServers.length = 0;
  });

  async function createRelay(): Promise<CDPRelayServer> {
    const httpServer = createHttpServer();
    await startHttpServer(httpServer, {});
    relayServers.push(httpServer);
    return new CDPRelayServer(httpServer, 'chrome');
  }

  it('prepareForReconnect resets connection state', async () => {
    const relay = await createRelay();

    // Set some state that would exist after a browser session
    // Access private fields for testing via any cast
    const r = relay as any;
    // Seed a client session with tab info (new ClientSession interface — no ws field)
    const fakeSession = {
      sessionId: 'test-client',
      send: () => {},
      sendRaw: () => {},
      close: () => {},
      isOpen: () => false,
      _connectionId: 1,
      cdpSessionId: 'session-test-client',
      targetInfo: { type: 'page' },
      tabId: null,
      downloadBehavior: null,
    };
    r._clients.set('test-client', fakeSession);
    r._playwrightReconnectCount = 2;
    r._graceBuffer = [{ data: 'event1', size: 12 }];
    r._graceBufferBytes = 12;

    relay.prepareForReconnect();

    // Connection state reset
    expect(r._clients.size).toBe(0);
    expect(r._extensionConnection).toBeNull();
    expect(r._playwrightReconnectCount).toBe(0);
    expect(r._graceBuffer).toEqual([]);
    expect(r._graceBufferBytes).toBe(0);
    expect(relay.state).toBe('disconnected');
  });

  it('prepareForReconnect is idempotent (safe on first call)', async () => {
    const relay = await createRelay();

    // Should not throw on a fresh relay with no connections
    expect(() => relay.prepareForReconnect()).not.toThrow();
    expect(relay.state).toBe('disconnected');
  });

  it('relay reuse — same CDP endpoint across reconnects', async () => {
    const relay = await createRelay();
    const endpointBefore = relay.cdpEndpoint();
    const extensionEndpointBefore = relay.extensionEndpoint();

    relay.prepareForReconnect();

    expect(relay.cdpEndpoint()).toBe(endpointBefore);
    expect(relay.extensionEndpoint()).toBe(extensionEndpointBefore);
  });
});
