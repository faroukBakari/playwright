import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installHttpTransport } from 'playwright-core/src/mcp/sdk/http';
import { createHttpServer } from 'playwright-core/src/server/utils/network';

import type { ServerBackendFactory } from 'playwright-core/src/mcp/sdk/server';

const IDLE_TTL_MS = 300;
const PAST_ONE_TTL_MS = 450;

const INIT_BODY = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'idle-timer-test', version: '1.0.0' } },
};
const CALL_BODY = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fixture_stall', arguments: {} } };

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function post(port: number, body: object, sessionId?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function openSessions(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data).sessions));
    }).on('error', reject);
  });
}

let tmpDir: string;
let origCwd: string;
let server: http.Server | undefined;
let releaseCall: () => void = () => {};

beforeEach(() => {
  // The transport persists its session id under the working directory.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-idle-timer-'));
  fs.mkdirSync(path.join(tmpDir, '.local'), { recursive: true });
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  releaseCall();
  process.chdir(origCwd);
  server?.closeAllConnections();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  server = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function startServer(): Promise<number> {
  const callGate = new Promise<void>(resolve => releaseCall = resolve);
  const factory: ServerBackendFactory = {
    name: 'test',
    nameInConfig: 'test',
    version: '1.0.0',
    toolSchemas: [],
    create: async () => ({
      callTool: async () => {
        await callGate;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    }),
    disposed: async () => {},
  };
  server = createHttpServer();
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  await installHttpTransport(server, factory, ['*'], IDLE_TTL_MS);
  return port;
}

describe('session idle timer and requests in flight', () => {
  it('regression: a session with a request in flight outlives the idle time and is closed one idle time after the response', async () => {
    const port = await startServer();
    const sessionId = (await post(port, INIT_BODY)).headers['mcp-session-id'] as string;

    const call = post(port, CALL_BODY, sessionId);
    await settle(PAST_ONE_TTL_MS);
    expect(await openSessions(port), 'the session was closed under a running request').toBe(1);

    releaseCall();
    expect((await call).status).toBe(200);
    await settle(IDLE_TTL_MS / 2);
    expect(await openSessions(port)).toBe(1);
    await settle(IDLE_TTL_MS);
    expect(await openSessions(port)).toBe(0);
  });

  it('control: an idle session is closed after one idle time', async () => {
    const port = await startServer();
    await post(port, INIT_BODY);
    expect(await openSessions(port)).toBe(1);

    await settle(PAST_ONE_TTL_MS);

    expect(await openSessions(port)).toBe(0);
  });
});
