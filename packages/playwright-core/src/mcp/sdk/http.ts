/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import crypto from 'crypto';

import { debug } from '../../utilsBundle';
import * as mcpBundle from '../../mcpBundle';
import { createHttpServer, startHttpServer } from '../../server/utils/network';

import * as mcpServer from './server';
import { serverLog } from '../log';

import type { ServerBackendFactory } from './server';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const testDebug = debug('pw:mcp:test');

// EventStore implementation for StreamableHTTPServerTransport resumability.
// When provided, the transport assigns event IDs to SSE messages and supports
// client reconnection via Last-Event-ID header (MCP protocol >= 2025-11-25).
// Bounded to MAX_EVENTS to prevent unbounded memory growth.
const MAX_EVENTS = 500;

class InMemoryEventStore {
  private _events = new Map<string, { streamId: string; message: JSONRPCMessage }>();
  private _counter = 0;

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${streamId}_${++this._counter}`;
    if (this._events.size >= MAX_EVENTS) {
      const oldest = this._events.keys().next().value!;
      this._events.delete(oldest);
    }
    this._events.set(eventId, { streamId, message });
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const entry = this._events.get(lastEventId);
    if (!entry)
      return '';
    const targetStreamId = entry.streamId;
    let found = false;
    for (const [eventId, ev] of this._events) {
      if (!found) {
        if (eventId === lastEventId)
          found = true;
        continue;
      }
      if (ev.streamId === targetStreamId)
        await send(eventId, ev.message);
    }
    return targetStreamId;
  }
}

// Session state persistence: survives server restarts so returning clients
// with a stale Mcp-Session-Id can be transparently recovered instead of 404'd.
export function sessionStateFile(): string {
  return path.join(process.cwd(), '.local', 'session-state.json');
}

function writeSessionState(sessionId: string): void {
  try {
    fs.writeFileSync(sessionStateFile(), JSON.stringify({
      sessionId,
      createdAt: new Date().toISOString(),
      pid: process.pid,
    }));
  } catch {
    // Non-critical — recovery just won't work after next restart.
  }
}

function readSessionState(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(sessionStateFile(), 'utf-8'));
    return data?.sessionId ?? null;
  } catch {
    return null;
  }
}

function deleteSessionState(): void {
  try {
    fs.unlinkSync(sessionStateFile());
  } catch {
    // Already gone or never existed.
  }
}

export async function startMcpHttpServer(
  config: { host?: string, port?: number },
  serverBackendFactory: ServerBackendFactory,
  allowedHosts?: string[]
): Promise<string> {
  const httpServer = createHttpServer();
  await startHttpServer(httpServer, config);
  return await installHttpTransport(httpServer, serverBackendFactory, allowedHosts);
}

export function addressToString(address: string | net.AddressInfo | null, options: {
  protocol: 'http' | 'ws';
  normalizeLoopback?: boolean;
}): string {
  assert(address, 'Could not bind server socket');
  if (typeof address === 'string')
    throw new Error('Unexpected address type: ' + address);
  let host = address.family === 'IPv4' ? address.address : `[${address.address}]`;
  if (options.normalizeLoopback && (host === '0.0.0.0' || host === '[::]' || host === '[::1]' || host === '127.0.0.1'))
    host = 'localhost';
  return `${options.protocol}://${host}:${address.port}`;
}

export async function installHttpTransport(httpServer: http.Server, serverBackendFactory: ServerBackendFactory, allowedHosts?: string[]) {
  const url = addressToString(httpServer.address(), { protocol: 'http', normalizeLoopback: true });
  const host = new URL(url).host;
  allowedHosts = (allowedHosts || [host]).map(h => h.toLowerCase());
  const allowAnyHost = allowedHosts.includes('*');

  const sseSessions = new Map();
  const streamableSessions = new Map();

  // Load persisted session ID from previous server instance (if any).
  let persistedSessionId = readSessionState();
  if (persistedSessionId)
    serverLog('session', `Loaded persisted session ID: ${persistedSessionId}`);

  // Idle TTL: auto-exit after inactivity. Default 30min. Set to 0 to disable.
  let lastActivity = Date.now();
  const idleTimeoutMs = parseInt(process.env.PLAYWRIGHT_MCP_IDLE_TTL || '1800', 10) * 1000;
  if (idleTimeoutMs > 0) {
    serverLog('lifecycle', `idle TTL enabled: ${idleTimeoutMs / 1000}s`);
    setInterval(() => {
      const idleMs = Date.now() - lastActivity;
      if (idleMs > idleTimeoutMs) {
        serverLog('idle', `no activity for ${Math.round(idleMs / 1000)}s (limit: ${idleTimeoutMs / 1000}s) — exiting`);
        process.exit(0);
      }
    }, 60_000).unref();
  } else {
    serverLog('lifecycle', 'idle TTL disabled');
  }

  httpServer.on('request', async (req, res) => {
    lastActivity = Date.now();

    if (!allowAnyHost) {
      const host = req.headers.host?.toLowerCase();
      if (!host) {
        res.statusCode = 400;
        return res.end('Missing host');
      }

      // Prevent DNS evil.com -> localhost rebind.
      if (!allowedHosts.includes(host)) {
        // Access from the browser is forbidden.
        res.statusCode = 403;
        return res.end('Access is only allowed at ' + allowedHosts.join(', '));
      }
    }

    const url = new URL(`http://localhost${req.url}`);
    if (url.pathname === '/killkillkill' && req.method === 'GET') {
      res.statusCode = 200;
      res.end('Killing process');
      // Simulate Ctrl+C in a way that works on Windows too.
      process.emit('SIGINT');
      return;
    }
    if (url.pathname.startsWith('/sse'))
      await handleSSE(serverBackendFactory, req, res, url, sseSessions);
    else
      await handleStreamable(serverBackendFactory, req, res, streamableSessions, persistedSessionId, id => { persistedSessionId = id; });
  });

  return url;
}

async function handleSSE(serverBackendFactory: ServerBackendFactory, req: http.IncomingMessage, res: http.ServerResponse, url: URL, sessions: Map<string, SSEServerTransport>) {
  if (req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.statusCode = 400;
      return res.end('Missing sessionId');
    }

    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      return res.end('Session not found');
    }

    return await transport.handlePostMessage(req, res);
  } else if (req.method === 'GET') {
    const transport = new mcpBundle.SSEServerTransport('/sse', res);
    sessions.set(transport.sessionId, transport);
    testDebug(`create SSE session`);
    serverLog('session', `SSE session created: ${transport.sessionId} (active: ${sessions.size})`);
    await mcpServer.connect(serverBackendFactory, transport, false, transport.sessionId);
    res.on('close', () => {
      testDebug(`delete SSE session`);
      sessions.delete(transport.sessionId);
      serverLog('session', `SSE session closed: ${transport.sessionId} (active: ${sessions.size})`);
    });
    return;
  }

  res.statusCode = 405;
  res.end('Method not allowed');
}

async function handleStreamable(
  serverBackendFactory: ServerBackendFactory,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: Map<string, StreamableHTTPServerTransport>,
  persistedSessionId: string | null,
  setPersistedSessionId: (id: string | null) => void,
) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (transport)
      return await transport.handleRequest(req, res);

    // Stale session recovery: client has a session ID from a previous server
    // instance. If it matches the persisted ID, transparently re-initialize
    // the transport so the client experiences zero disruption.
    if (persistedSessionId && sessionId === persistedSessionId) {
      serverLog('session', `Recovering stale session ${sessionId}`);
      const recovered = await recoverSession(serverBackendFactory, sessionId, sessions, setPersistedSessionId);
      if (recovered)
        return await recovered.handleRequest(req, res);
      // Recovery failed — fall through to 404.
    }

    res.statusCode = 404;
    res.end('Session not found');
    return;
  }

  if (req.method === 'POST') {
    const transport = new mcpBundle.StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      eventStore: new InMemoryEventStore(),
      onsessioninitialized: async sessionId => {
        testDebug(`create http session`);
        serverLog('session', `HTTP session created: ${sessionId} (active: ${sessions.size + 1})`);
        await mcpServer.connect(serverBackendFactory, transport, true, sessionId);
        sessions.set(sessionId, transport);
        // Persist for recovery after server restart.
        writeSessionState(sessionId);
        setPersistedSessionId(sessionId);
      }
    });

    transport.onclose = () => {
      if (!transport.sessionId)
        return;
      sessions.delete(transport.sessionId);
      deleteSessionState();
      setPersistedSessionId(null);
      testDebug(`delete http session`);
      serverLog('session', `HTTP session closed: ${transport.sessionId} (active: ${sessions.size})`);
    };

    await transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 400;
  res.end('Invalid request');
}

/**
 * Re-creates a StreamableHTTPServerTransport for a persisted session ID,
 * bypasses the SDK's initialize handshake via direct field assignment
 * (TypeScript `private` — plain JS properties at runtime), and connects
 * the MCP server backend so tool calls work immediately.
 */
async function recoverSession(
  serverBackendFactory: ServerBackendFactory,
  sessionId: string,
  sessions: Map<string, StreamableHTTPServerTransport>,
  setPersistedSessionId: (id: string | null) => void,
): Promise<StreamableHTTPServerTransport | null> {
  try {
    const transport = new mcpBundle.StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      eventStore: new InMemoryEventStore(),
    });

    // Bypass SDK initialize handshake: set the internal state directly.
    // These are TypeScript `private` but plain JS properties (not #private).
    const inner = (transport as any)._webStandardTransport;
    inner._initialized = true;
    inner.sessionId = sessionId;

    transport.onclose = () => {
      sessions.delete(sessionId);
      deleteSessionState();
      setPersistedSessionId(null);
      testDebug(`delete http session`);
      serverLog('session', `Recovered session closed: ${sessionId} (active: ${sessions.size})`);
    };

    // Connect MCP server — backend is created lazily on first tool call.
    await mcpServer.connect(serverBackendFactory, transport, true, sessionId);
    sessions.set(sessionId, transport);

    // Re-persist (same ID, new PID).
    writeSessionState(sessionId);
    serverLog('session', `Session recovered: ${sessionId} (active: ${sessions.size})`);
    return transport;
  } catch (e) {
    serverLog('session', `Session recovery failed: ${e}`);
    return null;
  }
}
