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
import net from 'net';
import http from 'http';
import crypto from 'crypto';

import { debug } from '../../utilsBundle';
import * as mcpBundle from '../../mcpBundle';
import { createHttpServer, startHttpServer } from '../../server/utils/network';

import * as mcpServer from './server';

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

async function installHttpTransport(httpServer: http.Server, serverBackendFactory: ServerBackendFactory, allowedHosts?: string[]) {
  const url = addressToString(httpServer.address(), { protocol: 'http', normalizeLoopback: true });
  const host = new URL(url).host;
  allowedHosts = (allowedHosts || [host]).map(h => h.toLowerCase());
  const allowAnyHost = allowedHosts.includes('*');

  const sseSessions = new Map();
  const streamableSessions = new Map();

  // Idle TTL: auto-exit after inactivity. Default 30min. Set to 0 to disable.
  let lastActivity = Date.now();
  const idleTimeoutMs = parseInt(process.env.PLAYWRIGHT_MCP_IDLE_TTL || '1800', 10) * 1000;
  if (idleTimeoutMs > 0) {
    setInterval(() => {
      if (Date.now() - lastActivity > idleTimeoutMs)
        process.exit(0);
    }, 60_000).unref();
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
      await handleStreamable(serverBackendFactory, req, res, streamableSessions);
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
    await mcpServer.connect(serverBackendFactory, transport, false);
    res.on('close', () => {
      testDebug(`delete SSE session`);
      sessions.delete(transport.sessionId);
    });
    return;
  }

  res.statusCode = 405;
  res.end('Method not allowed');
}

async function handleStreamable(serverBackendFactory: ServerBackendFactory, req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, StreamableHTTPServerTransport>) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }
    return await transport.handleRequest(req, res);
  }

  if (req.method === 'POST') {
    const transport = new mcpBundle.StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      eventStore: new InMemoryEventStore(),
      onsessioninitialized: async sessionId => {
        testDebug(`create http session`);
        await mcpServer.connect(serverBackendFactory, transport, true);
        sessions.set(sessionId, transport);
      }
    });

    transport.onclose = () => {
      if (!transport.sessionId)
        return;
      sessions.delete(transport.sessionId);
      testDebug(`delete http session`);
    };

    await transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 400;
  res.end('Invalid request');
}
