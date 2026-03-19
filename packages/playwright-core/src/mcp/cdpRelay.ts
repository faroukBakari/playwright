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

/**
 * WebSocket server that bridges Playwright MCP and Chrome Extension
 *
 * Endpoints:
 * - /cdp/guid - Full CDP interface for Playwright MCP (N concurrent clients)
 * - /extension/guid - Extension connection for chrome.debugger forwarding
 */

import http from 'http';

import { debug, ws, wsServer } from '../utilsBundle';
import { ManualPromise } from '../utils/isomorphic/manualPromise';

import { addressToString } from './sdk/http';
import { launchBrowserToExtension } from './browserLauncher';
import { logUnhandledError, serverLog } from './log';

import type websocket from 'ws';
import type { ClientInfo } from './sdk/server';
import type { ExtensionCommand, ExtensionEvents } from './protocol';
import type { WebSocket, WebSocketServer } from '../utilsBundle';

const debugLogger = debug('pw:mcp:relay');

export type RelayState = 'connected' | 'grace' | 'extensionGrace' | 'disconnected';

export interface ClientSession {
  clientId: string;
  ws: WebSocket;
  sessionId: string | null;     // Relay-assigned ('pw-tab-N'), null before Target.setAutoAttach
  tabId: number | null;         // Chrome tab ID from extension
  targetInfo: any | null;       // CDP TargetInfo from extension
  tabUrl: string | null;        // Last navigated URL (Page.frameNavigated tracking)
}

export interface CDPRelayOptions {
  graceTTL?: number;               // default: 5_000
  extensionGraceTTL?: number;      // default: 2_000
  chromeRelaunchDebounce?: number;  // default: 2_000 (Wave 3, wired later)
  graceBufferMaxBytes?: number;    // default: 2MB
  maxConcurrentClients?: number;   // default: 4
}

const DEFAULT_GRACE_TTL = 5_000;
const DEFAULT_EXTENSION_GRACE_TTL = 2_000;
const DEFAULT_GRACE_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_MAX_CONCURRENT_CLIENTS = 4;

type CDPCommand = {
  id: number;
  sessionId?: string;
  method: string;
  params?: any;
};

type CDPResponse = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string };
};

export class CDPRelayServer {
  private _wsHost: string;
  private _cdpPath: string;
  private _extensionPath: string;
  private _httpServer: http.Server;
  private _wss: WebSocketServer;
  private _extensionConnection: ExtensionConnection | null = null;
  private _nextSessionId: number = 1;
  private _extensionConnectionPromise!: ManualPromise<void>;

  // Multi-client state
  private _clients = new Map<string, ClientSession>();
  private _sessionToClient = new Map<string, string>();
  private readonly _maxConcurrentClients: number;
  private _lastDisconnectedSession: ClientSession | null = null;

  // Grace period state
  private _state: RelayState = 'disconnected';
  private _graceTimer: ReturnType<typeof setTimeout> | null = null;
  private _graceBuffer: { data: string; size: number }[] = [];
  private _graceBufferBytes = 0;
  private readonly _graceTTL: number;
  private readonly _graceBufferMaxBytes: number;

  // Extension grace period state
  private _extensionGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _extensionGraceTTL: number;

  // Playwright reconnection retry counter
  private _playwrightReconnectCount = 0;
  private readonly _maxPlaywrightReconnects = 3;

  // Sideband HTTP pending requests
  private _registryCallbacks = new Map<string, {
    resolve: (value: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(server: http.Server, _browserChannel: string, options?: CDPRelayOptions) {
    this._wsHost = addressToString(server.address(), { protocol: 'ws' });
    this._httpServer = server;
    this._graceTTL = options?.graceTTL ?? DEFAULT_GRACE_TTL;
    this._extensionGraceTTL = options?.extensionGraceTTL ?? DEFAULT_EXTENSION_GRACE_TTL;
    this._graceBufferMaxBytes = options?.graceBufferMaxBytes ?? DEFAULT_GRACE_BUFFER_MAX_BYTES;
    this._maxConcurrentClients = options?.maxConcurrentClients ?? DEFAULT_MAX_CONCURRENT_CLIENTS;

    const uuid = crypto.randomUUID();
    this._cdpPath = `/cdp/${uuid}`;
    this._extensionPath = `/extension/${uuid}`;

    this._resetExtensionConnection();
    this._wss = new wsServer({ server });
    this._wss.on('connection', this._onConnection.bind(this));
    this._installSidebandHTTP();
  }

  get state(): RelayState {
    return this._state;
  }

  get lastTabId(): number | null {
    for (const session of this._clients.values()) {
      if (session.tabId != null) return session.tabId;
    }
    return this._lastDisconnectedSession?.tabId ?? null;
  }

  get lastTabUrl(): string | null {
    for (const session of this._clients.values()) {
      if (session.tabUrl != null) return session.tabUrl;
    }
    return this._lastDisconnectedSession?.tabUrl ?? null;
  }

  get clientCount(): number {
    return this._clients.size;
  }

  /**
   * Reset connection-specific state while preserving infrastructure
   * (WS server, HTTP server, paths, tab memory). Called before reconnecting
   * to a new browser after the previous one died.
   */
  prepareForReconnect(): void {
    // Snapshot active session for tab continuity across browser death
    const sessionWithTab = [...this._clients.values()].find(s => s.tabId != null);
    if (sessionWithTab)
      this._lastDisconnectedSession = sessionWithTab;
    this._closeAllClients('preparing for reconnect');
    this._closeExtensionConnection('preparing for reconnect');
    this._cancelGrace();
    this._cancelExtensionGrace();
    this._nextSessionId = 1;
    this._playwrightReconnectCount = 0;
    this._graceBuffer = [];
    this._graceBufferBytes = 0;
    this._state = 'disconnected';
  }

  cdpEndpoint() {
    return `${this._wsHost}${this._cdpPath}`;
  }

  extensionEndpoint() {
    return `${this._wsHost}${this._extensionPath}`;
  }

  async ensureExtensionConnectionForMCPContext(clientInfo: ClientInfo, forceNewTab: boolean) {
    debugLogger('Ensuring extension connection for MCP context');
    if (this._extensionConnection)
      return;
    launchBrowserToExtension(this.extensionEndpoint(), forceNewTab);
    debugLogger('Waiting for incoming extension connection');
    await Promise.race([
      this._extensionConnectionPromise,
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error(`Extension connection timeout. Make sure the "Playwright MCP Bridge" extension is installed. See https://github.com/microsoft/playwright-mcp/blob/main/packages/extension/README.md for installation instructions.`));
      }, process.env.PWMCP_TEST_CONNECTION_TIMEOUT ? parseInt(process.env.PWMCP_TEST_CONNECTION_TIMEOUT, 10) : 5_000)),
    ]);
    debugLogger('Extension connection established');
  }

  stop(): void {
    this._cancelGrace();
    this._cancelExtensionGrace();
    this.closeConnections('Server stopped');
    this._wss.close();
  }

  closeConnections(reason: string) {
    this._closeAllClients(reason);
    this._closeExtensionConnection(reason);
  }

  private _onConnection(clientWs: WebSocket, request: http.IncomingMessage): void {
    const url = new URL(`http://localhost${request.url}`);
    debugLogger(`New connection to ${url.pathname}`);
    if (url.pathname === this._cdpPath) {
      this._handlePlaywrightConnection(clientWs);
    } else if (url.pathname === this._extensionPath) {
      this._handleExtensionConnection(clientWs);
    } else {
      debugLogger(`Invalid path: ${url.pathname}`);
      clientWs.close(4004, 'Invalid path');
    }
  }

  private _handlePlaywrightConnection(clientWs: WebSocket): void {
    // During grace period: accept reconnection, resume last session
    if (this._state === 'grace') {
      this._playwrightReconnectCount++;
      if (this._playwrightReconnectCount > this._maxPlaywrightReconnects) {
        serverLog('critical', `Playwright reconnect limit exceeded (${this._playwrightReconnectCount}/${this._maxPlaywrightReconnects})`);
        clientWs.close(1008, 'Reconnect limit exceeded');
        this._cancelGrace();
        this._extensionConnection?.sendRaw({ type: 'registry:serverDown' });
        this._closeExtensionConnection('Reconnect limit exceeded');
        this._state = 'disconnected';
        return;
      }
      debugLogger('Playwright reconnected during grace period');
      const clientId = this._lastDisconnectedSession?.clientId ?? crypto.randomUUID();
      const session: ClientSession = {
        clientId,
        ws: clientWs,
        sessionId: this._lastDisconnectedSession?.sessionId ?? null,
        tabId: this._lastDisconnectedSession?.tabId ?? null,
        targetInfo: this._lastDisconnectedSession?.targetInfo ?? null,
        tabUrl: this._lastDisconnectedSession?.tabUrl ?? null,
      };
      this._clients.set(clientId, session);
      if (session.sessionId)
        this._sessionToClient.set(session.sessionId, clientId);
      this._lastDisconnectedSession = null;
      this._cancelGrace();
      this._flushGraceBuffer(clientWs);
      this._state = 'connected';
      this._installPlaywrightHandlers(clientWs, clientId);
      return;
    }

    // Concurrency cap
    if (this._clients.size >= this._maxConcurrentClients) {
      debugLogger('Rejecting connection: concurrent client limit reached');
      clientWs.close(1008, 'Concurrent client limit reached');
      return;
    }

    // Reset reconnect counter only on transition from disconnected
    if (this._state === 'disconnected')
      this._playwrightReconnectCount = 0;

    const clientId = crypto.randomUUID();
    const session: ClientSession = {
      clientId,
      ws: clientWs,
      sessionId: null,
      tabId: null,
      targetInfo: null,
      tabUrl: null,
    };
    this._clients.set(clientId, session);
    this._state = 'connected';
    this._installPlaywrightHandlers(clientWs, clientId);
    debugLogger(`Client ${clientId} connected (${this._clients.size} total)`);
  }

  private _installPlaywrightHandlers(clientWs: WebSocket, clientId: string): void {
    clientWs.on('message', async data => {
      try {
        const message = JSON.parse(data.toString());
        await this._handlePlaywrightMessage(message, clientId);
      } catch (error: any) {
        debugLogger(`Error while handling Playwright message\n${data.toString()}\n`, error);
      }
    });
    clientWs.on('close', () => {
      const session = this._clients.get(clientId);
      if (!session || session.ws !== clientWs)
        return;

      // Remove from maps
      if (session.sessionId)
        this._sessionToClient.delete(session.sessionId);
      this._clients.delete(clientId);

      // If in extension grace and all clients gone — immediate disconnected
      if (this._state === 'extensionGrace' && this._clients.size === 0) {
        this._cancelExtensionGrace();
        this._state = 'disconnected';
        debugLogger('Last client closed during extension grace — disconnected');
        return;
      }

      // Last client: enter grace or go disconnected
      if (this._clients.size === 0) {
        this._lastDisconnectedSession = session;
        if (this._extensionConnection) {
          this._enterGrace();
        } else {
          this._state = 'disconnected';
        }
      }
      // Non-last disconnect: no state change
      debugLogger(`Client ${clientId} disconnected (${this._clients.size} remaining)`);
    });
    clientWs.on('error', error => {
      debugLogger('Playwright WebSocket error:', error);
    });
  }

  private _enterGrace(): void {
    debugLogger(`Entering grace period (${this._graceTTL}ms)`);
    this._state = 'grace';
    this._graceBuffer = [];
    this._graceBufferBytes = 0;
    this._graceTimer = setTimeout(() => {
      serverLog('critical', `Playwright grace expired after ${this._graceTTL}ms`);
      debugLogger('Grace period expired');
      this._graceTimer = null;
      this._state = 'disconnected';
      // Notify extension that server is gone
      this._extensionConnection?.sendRaw({ type: 'registry:serverDown' });
      this._closeExtensionConnection('Grace period expired');
    }, this._graceTTL);
  }

  private _cancelGrace(): void {
    if (this._graceTimer) {
      clearTimeout(this._graceTimer);
      this._graceTimer = null;
    }
  }

  private _flushGraceBuffer(targetWs: WebSocket): void {
    debugLogger(`Flushing ${this._graceBuffer.length} buffered events`);
    for (const event of this._graceBuffer) {
      if (targetWs.readyState === ws.OPEN)
        targetWs.send(event.data);
    }
    this._graceBuffer = [];
    this._graceBufferBytes = 0;
  }

  // --- Extension grace ---

  private _enterExtensionGrace(): void {
    debugLogger(`Entering extension grace period (${this._extensionGraceTTL}ms)`);
    this._state = 'extensionGrace';
    this._extensionGraceTimer = setTimeout(() => {
      serverLog('critical', `Extension grace expired after ${this._extensionGraceTTL}ms`);
      debugLogger('Extension grace period expired');
      this._extensionGraceTimer = null;
      this._state = 'disconnected';
      this._closeAllClients('Extension grace expired');
    }, this._extensionGraceTTL);
  }

  private _cancelExtensionGrace(): void {
    if (this._extensionGraceTimer) {
      clearTimeout(this._extensionGraceTimer);
      this._extensionGraceTimer = null;
    }
  }

  private _handleExtensionClose(c: ExtensionConnection, reason: string): void {
    debugLogger('Extension WebSocket closed:', reason, c === this._extensionConnection);
    if (this._extensionConnection !== c)
      return;
    this._resetExtensionConnection();
    if (this._clients.size === 0 || this._state === 'grace') {
      this._cancelGrace();
      this._graceBuffer = [];
      this._graceBufferBytes = 0;
      this._state = 'disconnected';
      this._closeAllClients(`Extension disconnected: ${reason}`);
      return;
    }
    this._enterExtensionGrace();
  }

  private _acceptExtensionReconnection(extWs: WebSocket): void {
    debugLogger('Extension reconnected during grace period');
    this._extensionConnection = new ExtensionConnection(extWs);
    this._extensionConnection.onmessage = this._handleExtensionMessage.bind(this);
    this._extensionConnection.onregistryresponse = this._handleRegistryResponse.bind(this);
    this._extensionConnection.onlogmessage = (msg) => {
      serverLog(`ext:${msg.channel || 'unknown'}`, msg.message || '');
    };
    this._extensionConnectionPromise.resolve();
    this._extensionConnection.onclose = this._handleExtensionClose.bind(this);

    // Reattach to the same tab — find from active clients first, then last disconnected
    const clientWithTab = [...this._clients.values()].find(s => s.tabId != null);
    const reattachTabId = clientWithTab?.tabId ?? this._lastDisconnectedSession?.tabId;
    if (reattachTabId != null) {
      this._extensionConnection.send('attachToTab', { tabId: reattachTabId }).then(
        (result) => {
          debugLogger(`Extension reattached to tab ${reattachTabId}`);
          if (result.targetInfo && clientWithTab) {
            clientWithTab.targetInfo = result.targetInfo;
          }
          this._state = 'connected';
        },
        (error) => {
          serverLog('critical', `Extension reattach failed: ${error.message}`);
          this._state = 'disconnected';
          this._closeAllClients('Extension reattach failed');
        }
      );
    } else {
      // No tab to reattach — can't resume, go disconnected
      serverLog('critical', 'Extension reconnected but no tab to reattach — cannot resume');
      this._state = 'disconnected';
      this._closeAllClients('No tab to reattach');
    }
  }

  private _bufferEvent(data: string): void {
    const size = data.length * 2; // rough byte estimate (UTF-16)
    while (this._graceBufferBytes + size > this._graceBufferMaxBytes && this._graceBuffer.length > 0) {
      const evicted = this._graceBuffer.shift()!;
      this._graceBufferBytes -= evicted.size;
    }
    this._graceBuffer.push({ data, size });
    this._graceBufferBytes += size;
  }

  private _closeExtensionConnection(reason: string) {
    this._extensionConnection?.close(reason);
    this._extensionConnectionPromise.reject(new Error(reason));
    // Fail any pending sideband HTTP requests
    for (const [id, cb] of this._registryCallbacks) {
      clearTimeout(cb.timer);
      this._registryCallbacks.delete(id);
    }
    this._resetExtensionConnection();
  }

  private _resetExtensionConnection() {
    this._extensionConnection = null;
    this._extensionConnectionPromise = new ManualPromise();
    void this._extensionConnectionPromise.catch(logUnhandledError);
  }

  private _closeAllClients(reason: string): void {
    for (const session of this._clients.values()) {
      if (session.ws.readyState === ws.OPEN)
        session.ws.close(1000, reason);
    }
    this._clients.clear();
    this._sessionToClient.clear();
  }

  private _handleExtensionConnection(extWs: WebSocket): void {
    // During extension grace: accept reconnection from restarted service worker
    if (this._state === 'extensionGrace') {
      this._cancelExtensionGrace();
      this._acceptExtensionReconnection(extWs);
      return;
    }
    if (this._extensionConnection) {
      extWs.close(1000, 'Another extension connection already established');
      return;
    }
    this._extensionConnection = new ExtensionConnection(extWs);
    this._extensionConnection.onclose = this._handleExtensionClose.bind(this);
    this._extensionConnection.onmessage = this._handleExtensionMessage.bind(this);
    this._extensionConnection.onregistryresponse = this._handleRegistryResponse.bind(this);
    this._extensionConnection.onlogmessage = (msg) => {
      serverLog(`ext:${msg.channel || 'unknown'}`, msg.message || '');
    };
    this._extensionConnectionPromise.resolve();
  }

  private _handleExtensionMessage<M extends keyof ExtensionEvents>(method: M, params: ExtensionEvents[M]['params']) {
    switch (method) {
      case 'forwardCDPEvent': {
        // Route to correct client via sessionId → clientId lookup
        let targetSession: ClientSession | undefined;
        const targetClientId = params.sessionId ? this._sessionToClient.get(params.sessionId) : undefined;
        if (targetClientId) {
          targetSession = this._clients.get(targetClientId);
        } else if (this._clients.size === 1) {
          // Single-client fallback (backward compat)
          targetSession = this._clients.values().next().value;
        }
        // Multi-client with no sessionId match: event dropped (Wave 2 adds extension-side tagging)

        // Track top-frame navigations for URL per-client
        if (params.method === 'Page.frameNavigated' && params.params?.frame && !params.params.frame.parentFrameId) {
          if (targetSession)
            targetSession.tabUrl = params.params.frame.url ?? null;
        }

        const sessionId = params.sessionId || targetSession?.sessionId;
        const message: CDPResponse = {
          sessionId,
          method: params.method,
          params: params.params
        };
        if (this._state === 'grace') {
          this._bufferEvent(JSON.stringify(message));
        } else if (targetSession) {
          this._sendToClient(targetSession.ws, message);
        }
        break;
      }
    }
  }

  private async _handlePlaywrightMessage(message: CDPCommand, clientId: string): Promise<void> {
    debugLogger('← Client:', `${message.method} (id=${message.id})`);
    const session = this._clients.get(clientId);
    if (!session) return; // client disconnected mid-flight
    const { id, sessionId, method, params } = message;
    // Fail-fast: no extension to forward to during extension grace
    if (this._state === 'extensionGrace') {
      this._sendToClient(session.ws, {
        id,
        sessionId,
        error: { code: -32000, message: 'Extension reconnecting' }
      });
      return;
    }
    try {
      const result = await this._handleCDPCommand(method, params, sessionId, clientId);
      this._sendToClient(session.ws, { id, sessionId, result });
    } catch (e) {
      debugLogger('Error in the extension:', e);
      this._sendToClient(session.ws, {
        id,
        sessionId,
        error: { message: (e as Error).message }
      });
    }
  }

  private async _handleCDPCommand(method: string, params: any, sessionId: string | undefined, clientId: string): Promise<any> {
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        };
      }
      case 'Browser.setDownloadBehavior': {
        return { };
      }
      case 'Target.setAutoAttach': {
        // Forward child session handling.
        if (sessionId)
          break;
        // Simulate auto-attach behavior with real target info
        const attachResult = await this._extensionConnection!.send('attachToTab', { });
        const { targetInfo } = attachResult;
        const session = this._clients.get(clientId);
        if (!session) return {}; // client disconnected mid-flight
        if (attachResult.tabId != null)
          session.tabId = attachResult.tabId;
        session.targetInfo = targetInfo;
        session.sessionId = `pw-tab-${this._nextSessionId++}`;
        this._sessionToClient.set(session.sessionId, clientId);
        debugLogger('Simulating auto-attach');
        this._sendToClient(session.ws, {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: session.sessionId,
            targetInfo: {
              ...targetInfo,
              attached: true,
            },
            waitingForDebugger: false
          }
        });
        return { };
      }
      case 'Target.getTargetInfo': {
        const session = this._clients.get(clientId);
        return session?.targetInfo;
      }
    }
    return await this._forwardToExtension(method, params, sessionId, clientId);
  }

  private async _forwardToExtension(method: string, params: any, sessionId: string | undefined, clientId: string): Promise<any> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    // Top level sessionId is only passed between the relay and the client.
    const session = this._clients.get(clientId);
    if (session?.sessionId === sessionId)
      sessionId = undefined;
    return await this._extensionConnection.send('forwardCDPCommand', { sessionId, method, params });
  }

  private _sendToClient(targetWs: WebSocket, message: CDPResponse): void {
    debugLogger('→ Client:', `${message.method ?? `response(id=${message.id})`}`);
    if (targetWs.readyState === ws.OPEN)
      targetWs.send(JSON.stringify(message));
  }

  // --- Sideband HTTP ---

  private _installSidebandHTTP(): void {
    this._httpServer.on('request', (req, res) => {
      const url = new URL(`http://localhost${req.url}`);
      if (url.pathname === '/registry' && req.method === 'GET')
        this._handleRegistryList(res);
      else if (url.pathname === '/registry/focus' && req.method === 'POST')
        this._handleRegistryFocus(req, res);
      // Other paths fall through to WSS upgrade or are ignored
    });
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
    if (!this._extensionConnection) {
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
    this._extensionConnection.sendRaw({ ...message, _callbackId: id });
  }

  /** Called by ExtensionConnection when a registry:* response arrives */
  _handleRegistryResponse(parsed: any): void {
    const id = parsed._callbackId;
    if (!id) return;
    const cb = this._registryCallbacks.get(id);
    if (!cb) return;
    // Strip internal routing field before returning
    delete parsed._callbackId;
    cb.resolve(parsed);
  }
}

class ExtensionConnection {
  private readonly _ws: WebSocket;
  private readonly _callbacks = new Map<number, { resolve: (o: any) => void, reject: (e: Error) => void, error: Error }>();
  private _lastId = 0;

  onmessage?: <M extends keyof ExtensionEvents>(method: M, params: ExtensionEvents[M]['params']) => void;
  onclose?: (self: ExtensionConnection, reason: string) => void;
  onregistryresponse?: (parsed: any) => void;
  onlogmessage?: (parsed: any) => void;

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.on('message', this._onMessage.bind(this));
    this._ws.on('close', this._onClose.bind(this));
    this._ws.on('error', this._onError.bind(this));
  }

  async send<M extends keyof ExtensionCommand>(method: M, params: ExtensionCommand[M]['params']): Promise<any> {
    if (this._ws.readyState !== ws.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    const id = ++this._lastId;
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
    });
  }

  sendRaw(message: any): void {
    if (this._ws.readyState === ws.OPEN)
      this._ws.send(JSON.stringify(message));
  }

  close(message: string) {
    debugLogger('closing extension connection:', message);
    if (this._ws.readyState === ws.OPEN)
      this._ws.close(1000, message);
  }

  private _onMessage(event: websocket.RawData) {
    const eventData = event.toString();
    let parsedJson;
    try {
      parsedJson = JSON.parse(eventData);
    } catch (e: any) {
      debugLogger(`<closing ws> Closing websocket due to malformed JSON. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
      return;
    }
    try {
      this._handleParsedMessage(parsedJson);
    } catch (e: any) {
      debugLogger(`<closing ws> Closing websocket due to failed onmessage callback. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
    }
  }

  private _handleParsedMessage(object: any) {
    // Route registry responses (type-based) to the relay's HTTP handler
    if (typeof object.type === 'string' && object.type.startsWith('registry:')) {
      this.onregistryresponse?.(object);
      return;
    }
    // Route extension log messages to serverLog
    if (typeof object.type === 'string' && object.type.startsWith('log:')) {
      this.onlogmessage?.(object);
      return;
    }
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id)!;
      this._callbacks.delete(object.id);
      if (object.error) {
        const error = callback.error;
        error.message = object.error;
        callback.reject(error);
      } else {
        callback.resolve(object.result);
      }
    } else if (object.id) {
      debugLogger('← Extension: unexpected response', object);
    } else {
      this.onmessage?.(object.method! as keyof ExtensionEvents, object.params);
    }
  }

  private _onClose(event: websocket.CloseEvent) {
    debugLogger(`<ws closed> code=${event.code} reason=${event.reason}`);
    this._dispose();
    this.onclose?.(this, event.reason);
  }

  private _onError(event: websocket.ErrorEvent) {
    debugLogger(`<ws error> message=${event.message} type=${event.type} target=${event.target}`);
    this._dispose();
  }

  private _dispose() {
    for (const callback of this._callbacks.values())
      callback.reject(new Error('WebSocket closed'));
    this._callbacks.clear();
  }
}
