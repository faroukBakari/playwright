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

import type http from 'http';

import type { RelayState } from './cdpRelay';

export interface RelayHTTPDelegate {
  activeSessions(): Array<{ sessionId: string; cdpSessionId: string | null; tab: { tabId: number; url: string; title: string } | null }>;
  readonly state: RelayState;
  listTabs(): Promise<any>;
  createTab(sessionId: string, url?: string): Promise<any>;
  attachTab(sessionId: string, tabId: number): Promise<any>;
}

export function installRelayHTTPEndpoints(server: http.Server, relay: RelayHTTPDelegate): void {
  server.on('request', async (req, res) => {
    const url = new URL(`http://localhost${req.url}`);

    if (url.pathname === '/sessions' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ sessions: relay.activeSessions(), state: relay.state }));
      return;
    }

    if (url.pathname === '/tabs' && req.method === 'GET') {
      try {
        const result = await relay.listTabs();
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 503;
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url.pathname === '/tabs/create' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => body += chunk.toString());
      req.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 400;
          res.end();
        }
      });
      req.on('end', async () => {
        try {
          const { sessionId, url: tabUrl } = JSON.parse(body);
          if (!sessionId) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'sessionId is required' }));
            return;
          }
          const result = await relay.createTab(sessionId, tabUrl);
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (url.pathname === '/tabs/attach' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => body += chunk.toString());
      req.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 400;
          res.end();
        }
      });
      req.on('end', async () => {
        try {
          const { sessionId, tabId } = JSON.parse(body);
          if (!sessionId || tabId == null) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'sessionId and tabId are required' }));
            return;
          }
          const result = await relay.attachTab(sessionId, tabId);
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  });
}
