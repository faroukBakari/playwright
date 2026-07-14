import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { installHttpTransport, sessionStateFile } from 'playwright-core/src/mcp/sdk/http';
import { createHttpServer } from 'playwright-core/src/server/utils/network';

import type { ServerBackendFactory } from 'playwright-core/src/mcp/sdk/server';

/** Minimal backend factory — no browser, just enough for MCP server creation. */
function createTestFactory(): ServerBackendFactory {
  return {
    name: 'test',
    nameInConfig: 'test',
    version: '1.0.0',
    toolSchemas: [],
    create: async () => ({
      callTool: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    }),
    disposed: async () => {},
  };
}

/** POST a JSON-RPC body, optionally with Mcp-Session-Id header. */
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

/** DELETE request to close a session. */
async function mcpDelete(port: number, sessionId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      method: 'DELETE',
      path: '/mcp',
      headers: { 'Mcp-Session-Id': sessionId },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
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

const LIST_TOOLS_BODY = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
};

let tmpDir: string;
let origCwd: string;
const servers: http.Server[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-recovery-'));
  fs.mkdirSync(path.join(tmpDir, '.local'), { recursive: true });
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(origCwd);
  // Close all servers created during the test
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
  servers.length = 0;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create an HTTP server on a random port with MCP transport installed. */
async function createServer(factory: ServerBackendFactory): Promise<{ server: http.Server; port: number }> {
  const server = createHttpServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  await installHttpTransport(server, factory, ['*']);
  servers.push(server);
  return { server, port };
}

describe('Session Recovery', () => {

  it('normal session lifecycle — initialize then tools/list', async () => {
    const { port } = await createServer(createTestFactory());

    // Initialize
    const initRes = await mcpPost(port, INIT_BODY);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers['mcp-session-id'] as string;
    expect(sessionId).toBeTruthy();

    // tools/list with valid session
    const listRes = await mcpPost(port, LIST_TOOLS_BODY, sessionId);
    expect(listRes.status).toBe(200);
  });

  it('on-demand session creation — unknown Mcp-Session-Id + POST creates session', async () => {
    const { port } = await createServer(createTestFactory());

    // Unknown session ID on a POST → on-demand creation (not 404)
    const res = await mcpPost(port, LIST_TOOLS_BODY, 'nonexistent-session-id');
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBe('nonexistent-session-id');
  });

  it('persisted session recovers after simulated restart', async () => {
    const factory = createTestFactory();

    // --- Server instance 1: create a session ---
    const { server: server1, port: port1 } = await createServer(factory);

    const initRes = await mcpPost(port1, INIT_BODY);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers['mcp-session-id'] as string;
    expect(sessionId).toBeTruthy();

    // Verify session state was persisted to disk
    const stateFile = sessionStateFile();
    expect(fs.existsSync(stateFile)).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(state.sessionId).toBe(sessionId);

    // Close server 1 — simulates restart (in-memory sessions gone)
    await new Promise<void>(r => server1.close(() => r()));
    servers.splice(servers.indexOf(server1), 1);

    // --- Server instance 2: same cwd, reads persisted state ---
    const { port: port2 } = await createServer(factory);

    // tools/list with the OLD session ID → should recover, not 404
    const listRes = await mcpPost(port2, LIST_TOOLS_BODY, sessionId);
    expect(listRes.status).toBe(200);
    expect(listRes.headers['mcp-session-id']).toBe(sessionId);
  });

  it('on-demand session creation — unknown ID works even with persisted state', async () => {
    const factory = createTestFactory();

    // Create a session so there is a persisted ID
    const { server: server1, port: port1 } = await createServer(factory);
    const initRes = await mcpPost(port1, INIT_BODY);
    expect(initRes.status).toBe(200);
    await new Promise<void>(r => server1.close(() => r()));
    servers.splice(servers.indexOf(server1), 1);

    // Server 2 — send a DIFFERENT (unknown) session ID → on-demand creation
    const { port: port2 } = await createServer(factory);
    const res = await mcpPost(port2, LIST_TOOLS_BODY, 'completely-wrong-id');
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBe('completely-wrong-id');
  });

  it('on-demand session creation — tools/call with unknown ID creates working session', async () => {
    const { port } = await createServer(createTestFactory());

    // POST tools/call with an unknown Mcp-Session-Id → creates session on demand
    const toolCallBody = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    };
    const res = await mcpPost(port, toolCallBody, 'bridge-agent-session-123');
    // Session is created (200), even if the tool doesn't exist (error is in JSON-RPC, not HTTP)
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBe('bridge-agent-session-123');

    // Subsequent request with same ID routes to existing session
    const listRes = await mcpPost(port, LIST_TOOLS_BODY, 'bridge-agent-session-123');
    expect(listRes.status).toBe(200);
    expect(listRes.headers['mcp-session-id']).toBe('bridge-agent-session-123');
  });

  it('GET /health returns 200 without creating a session', async () => {
    const { port } = await createServer(createTestFactory());

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`http://localhost:${port}/health`, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      }).on('error', reject);
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.status).toBe('ok');
    expect(parsed.sessions).toBe(0);

    // No session state file should exist — health check doesn't create sessions
    expect(fs.existsSync(sessionStateFile())).toBe(false);
  });

  it('session state file survives session close (for recovery after restart)', async () => {
    const { port } = await createServer(createTestFactory());

    const initRes = await mcpPost(port, INIT_BODY);
    const sessionId = initRes.headers['mcp-session-id'] as string;

    const stateFile = sessionStateFile();
    expect(fs.existsSync(stateFile)).toBe(true);

    // DELETE request closes the session in the MCP SDK
    await mcpDelete(port, sessionId);

    // Give the onclose handler a tick to fire
    await new Promise(r => setTimeout(r, 100));
    // State file is NOT deleted — it must survive for stale session recovery.
    // It is overwritten when a new session is created.
    expect(fs.existsSync(stateFile)).toBe(true);
  });
});
