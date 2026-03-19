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
import type { ExtensionConnection } from './extensionConnection';

export class SidebandRegistry {
  private _registryCallbacks = new Map<string, {
    resolve: (value: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private readonly _getExtensionConnection: () => ExtensionConnection | null;

  constructor(getExtensionConnection: () => ExtensionConnection | null) {
    this._getExtensionConnection = getExtensionConnection;
  }

  installHTTP(server: http.Server): void {
    server.on('request', (req, res) => {
      const url = new URL(`http://localhost${req.url}`);
      if (url.pathname === '/registry' && req.method === 'GET')
        this._handleRegistryList(res);
      else if (url.pathname === '/registry/focus' && req.method === 'POST')
        this._handleRegistryFocus(req, res);
      // Other paths fall through to WSS upgrade or are ignored
    });
  }

  /** Called by ExtensionConnection when a registry:* response arrives */
  handleRegistryResponse(parsed: any): void {
    const id = parsed._callbackId;
    if (!id) return;
    const cb = this._registryCallbacks.get(id);
    if (!cb) return;
    // Strip internal routing field before returning
    delete parsed._callbackId;
    cb.resolve(parsed);
  }

  /** Fail all pending sideband HTTP requests (e.g. on extension disconnect) */
  failPending(): void {
    for (const [id, cb] of this._registryCallbacks) {
      clearTimeout(cb.timer);
      this._registryCallbacks.delete(id);
    }
  }

  private _handleRegistryList(res: http.ServerResponse): void {
    this._sendRegistryQuery({ type: 'registry:list' }, res);
  }

  private _handleRegistryFocus(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => body += chunk.toString());
    req.on('end', () => {
      try {
        const { tabId } = JSON.parse(body);
        if (typeof tabId !== 'number') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'tabId must be a number' }));
          return;
        }
        this._sendRegistryQuery({ type: 'registry:focus', tabId }, res);
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
  }

  private _sendRegistryQuery(message: any, res: http.ServerResponse): void {
    const ext = this._getExtensionConnection();
    if (!ext) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'Extension not connected' }));
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      this._registryCallbacks.delete(id);
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'Extension response timeout' }));
    }, 5000);
    this._registryCallbacks.set(id, {
      resolve: (data: any) => {
        clearTimeout(timer);
        this._registryCallbacks.delete(id);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(data));
      },
      timer,
    });
    // Tag with _callbackId so we can route the response back
    ext.sendRaw({ ...message, _callbackId: id });
  }
}
