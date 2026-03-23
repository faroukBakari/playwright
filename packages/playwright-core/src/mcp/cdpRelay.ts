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
 * - /cdp/guid?sessionId=X - Full CDP interface for Playwright MCP (N concurrent clients)
 * - /extension/guid - Extension connection for chrome.debugger forwarding
 *
 * Identity model: a single `sessionId` cascades MCP → Relay → CDP.
 * The relay-level sessionId is parsed from the WS upgrade URL query param
 * (?sessionId=). CDP child sessions use `cdpSessionId` (derived as
 * `session-${sessionId}`).
 */

import http from 'http';

import { debug, ws, wsServer } from '../utilsBundle';
import { ManualPromise } from '../utils/isomorphic/manualPromise';

import { addressToString } from './sdk/http';
import { launchBrowserToExtension } from './browserLauncher';
import { ExtensionConnection } from './extensionConnection';
import { SidebandRegistry } from './sidebandRegistry';
import { SessionGraceManager } from './sessionGrace';
import { installRelayHTTPEndpoints } from './relayHttpEndpoints';
import { logUnhandledError, serverLog } from './log';

import type { ClientInfo } from './sdk/server';
import type { ExtensionEvents } from './protocol';
import type { WebSocket, WebSocketServer } from '../utilsBundle';
import type { GracedSession } from './sessionGrace';

const debugLogger = debug('pw:mcp:relay');

export type RelayState = 'connected' | 'grace' | 'extensionGrace' | 'disconnected';

export interface ClientSession {
  sessionId: string;              // MCP-level identity, from WS query param or UUID fallback
  ws: WebSocket;
  cdpSessionId: string | null;    // Derived 'session-{sessionId}', null before Target.setAutoAttach
  targetInfo: any | null;         // CDP TargetInfo from extension
  tabId: number | null;           // Chrome tab ID, set on attach
}

interface DormantSession {
  sessionId: string;
  tabId: number;
  targetInfo: any;
  dormantSince: number;
}

export interface CDPRelayOptions {
  graceTTL?: number;               // default: 5_000
  extensionGraceTTL?: number;      // default: 2_000
  extensionCommandTimeout?: number; // default: 10_000 — lifecycle commands (attachToTab, recoverSessions)
  chromeRelaunchDebounce?: number;  // default: 2_000 (Wave 3, wired later)
  graceBufferMaxBytes?: number;    // default: 2MB
  maxConcurrentClients?: number;   // default: 4
  sessionGraceTTL?: number;        // default: 30_000
}

const DEFAULT_GRACE_TTL = 5_000;
const DEFAULT_EXTENSION_GRACE_TTL = 2_000;
const DEFAULT_EXTENSION_COMMAND_TIMEOUT = 10_000;
const DEFAULT_GRACE_BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_MAX_CONCURRENT_CLIENTS = 4;
const DEFAULT_SESSION_GRACE_TTL = 30_000;

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
  private _wss: WebSocketServer;
  private _extensionConnection: ExtensionConnection | null = null;
  private _extensionConnectionPromise!: ManualPromise<void>;

  // Multi-client state — keyed by sessionId (MCP-level identity)
  private _clients = new Map<string, ClientSession>();
  private readonly _maxConcurrentClients: number;
  private _sessionGrace: SessionGraceManager;
  private _dormantSessions = new Map<string, DormantSession>();
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
  private readonly _extensionCommandTimeout: number;

  // Playwright reconnection retry counter
  private _playwrightReconnectCount = 0;
  private readonly _maxPlaywrightReconnects = 3;

  // Cached download behavior — applied to new tabs on attach.
  // downloadPath intentionally omitted: WSL paths can't be resolved by Chrome on Windows.
  // eventsEnabled ensures Page-level download events fire for relay translation.
  private _downloadBehavior: { behavior: string; eventsEnabled: boolean } | null = null;

  // Sideband HTTP registry (extracted)
  private _sidebandRegistry: SidebandRegistry;

  constructor(server: http.Server, _browserChannel: string, options?: CDPRelayOptions) {
    this._wsHost = addressToString(server.address(), { protocol: 'ws' });
    this._graceTTL = options?.graceTTL ?? DEFAULT_GRACE_TTL;
    this._extensionGraceTTL = options?.extensionGraceTTL ?? DEFAULT_EXTENSION_GRACE_TTL;
    this._extensionCommandTimeout = options?.extensionCommandTimeout ?? DEFAULT_EXTENSION_COMMAND_TIMEOUT;
    this._graceBufferMaxBytes = options?.graceBufferMaxBytes ?? DEFAULT_GRACE_BUFFER_MAX_BYTES;
    this._maxConcurrentClients = options?.maxConcurrentClients ?? DEFAULT_MAX_CONCURRENT_CLIENTS;
    this._sessionGrace = new SessionGraceManager(options?.sessionGraceTTL ?? DEFAULT_SESSION_GRACE_TTL);

    const uuid = crypto.randomUUID();
    this._cdpPath = `/cdp/${uuid}`;
    this._extensionPath = `/extension/${uuid}`;

    this._resetExtensionConnection();
    this._sidebandRegistry = new SidebandRegistry(() => this._extensionConnection);
    this._sidebandRegistry.installHTTP(server);
    installRelayHTTPEndpoints(server, this);
    this._wss = new wsServer({ server });
    this._wss.on('connection', this._onConnection.bind(this));
  }

  get state(): RelayState {
    return this._state;
  }

  get clientCount(): number {
    return this._clients.size;
  }

  /** True when per-session grace is holding tab bindings for disconnected sessions. */
  get hasGracedSessions(): boolean {
    return this._sessionGrace.size > 0;
  }

  /**
   * Reset connection-specific state while preserving infrastructure
   * (WS server, HTTP server, paths, tab memory). Called before reconnecting
   * to a new browser after the previous one died.
   */
  prepareForReconnect(): void {
    this._lastDisconnectedSession = null;
    this._closeAllClients('preparing for reconnect');
    this._closeExtensionConnection('preparing for reconnect');
    this._cancelGrace();
    this._cancelExtensionGrace();
    this._sessionGrace.cancelAll();
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
    this._sessionGrace.cancelAll();
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
      // Parse sessionId from query param; fall back to random UUID for backward compat
      const sessionId = url.searchParams.get('sessionId') ?? crypto.randomUUID();
      this._handlePlaywrightConnection(clientWs, sessionId);
    } else if (url.pathname === this._extensionPath) {
      this._handleExtensionConnection(clientWs);
    } else {
      debugLogger(`Invalid path: ${url.pathname}`);
      clientWs.close(4004, 'Invalid path');
    }
  }

  private _handlePlaywrightConnection(clientWs: WebSocket, sessionId: string): void {
    // Per-session grace: same sessionId reconnecting within TTL.
    // Checked FIRST — per-session grace has the correct session-specific
    // data (cdpSessionId, targetInfo, tabId), whereas server grace only
    // knows about the _lastDisconnectedSession (wrong for multi-session).
    const gracedSession = this._sessionGrace.cancel(sessionId);
    if (gracedSession) {
      debugLogger(`Session ${sessionId} reconnected during per-session grace`);
      // Also cancel server grace if active — a session is back
      if (this._state === 'grace') {
        this._cancelGrace();
        this._flushGraceBuffer(clientWs);
      }
      const session: ClientSession = {
        sessionId,
        ws: clientWs,
        cdpSessionId: gracedSession.cdpSessionId,
        targetInfo: gracedSession.targetInfo,
        tabId: gracedSession.tabId,
      };
      this._clients.set(sessionId, session);
      this._state = 'connected';
      this._installPlaywrightHandlers(clientWs, sessionId);
      return;
    }

    // Dormant: session was graced, debugger detached, but tab still alive
    const dormant = this._dormantSessions.get(sessionId);
    if (dormant) {
      this._dormantSessions.delete(sessionId);
      debugLogger(`Session ${sessionId} reconnected from dormant (tab ${dormant.tabId})`);
      if (this._state === 'grace') {
        this._cancelGrace();
        this._flushGraceBuffer(clientWs);
      }
      const session: ClientSession = {
        sessionId,
        ws: clientWs,
        cdpSessionId: null,
        targetInfo: null,
        tabId: dormant.tabId,
      };
      this._clients.set(sessionId, session);
      this._state = 'connected';
      this._installPlaywrightHandlers(clientWs, sessionId);
      return;
    }

    // During server grace period: accept reconnection, resume last session
    // (fallback for single-session scenarios without per-session grace)
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
      const session: ClientSession = {
        sessionId,
        ws: clientWs,
        cdpSessionId: this._lastDisconnectedSession?.cdpSessionId ?? null,
        targetInfo: this._lastDisconnectedSession?.targetInfo ?? null,
        tabId: this._lastDisconnectedSession?.tabId ?? null,
      };
      this._clients.set(sessionId, session);
      this._lastDisconnectedSession = null;
      this._cancelGrace();
      this._flushGraceBuffer(clientWs);
      this._state = 'connected';
      this._installPlaywrightHandlers(clientWs, sessionId);
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

    const session: ClientSession = {
      sessionId,
      ws: clientWs,
      cdpSessionId: null,
      targetInfo: null,
      tabId: null,
    };
    this._clients.set(sessionId, session);
    this._state = 'connected';
    this._installPlaywrightHandlers(clientWs, sessionId);
  }

  private _installPlaywrightHandlers(clientWs: WebSocket, sessionId: string): void {
    clientWs.on('message', async data => {
      try {
        const message = JSON.parse(data.toString());
        await this._handlePlaywrightMessage(message, sessionId);
      } catch (error: any) {
        debugLogger(`Error while handling Playwright message\n${data.toString()}\n`, error);
      }
    });
    clientWs.on('close', () => {
      const session = this._clients.get(sessionId);
      if (!session || session.ws !== clientWs)
        return;

      // Remove from active clients
      this._clients.delete(sessionId);

      // Try per-session grace (preserves tab binding)
      const enteredGrace = this._sessionGrace.enter(
        sessionId,
        session.cdpSessionId,
        session.targetInfo,
        session.tabId,
        (expiredSessionId: string, gracedData: GracedSession) => {
          // Grace expired — NOW send detachTab
          debugLogger(`Per-session grace expired for ${expiredSessionId}`);
          if (this._extensionConnection) {
            this._extensionConnection.send('detachTab', { sessionId: expiredSessionId }).catch(() => {});
          }
          // Move to dormant — session lives as long as the tab exists
          if (gracedData.tabId != null) {
            this._dormantSessions.set(expiredSessionId, {
              sessionId: expiredSessionId,
              tabId: gracedData.tabId,
              targetInfo: gracedData.targetInfo,
              dormantSince: Date.now(),
            });
          }
        }
      );

      // If session had no tab binding (cdpSessionId null), do immediate cleanup as before
      if (!enteredGrace && session.cdpSessionId != null && this._extensionConnection) {
        this._extensionConnection.send('detachTab', { sessionId }).catch(() => {});
      }

      // If in extension grace and all clients gone — immediate disconnected
      if (this._state === 'extensionGrace' && this._clients.size === 0) {
        this._cancelExtensionGrace();
        this._sessionGrace.cancelAll((sid: string, _graced: GracedSession) => {
          if (this._extensionConnection)
            this._extensionConnection.send('detachTab', { sessionId: sid }).catch(() => {});
        });
        this._state = 'disconnected';
        debugLogger('Last client closed during extension grace — disconnected');
        return;
      }

      // Last client: enter server-level grace or go disconnected
      if (this._clients.size === 0) {
        this._lastDisconnectedSession = session;
        if (this._extensionConnection) {
          this._enterGrace();
        } else {
          this._sessionGrace.cancelAll();
          this._state = 'disconnected';
        }
      }
      debugLogger(`Session ${sessionId} disconnected (${this._clients.size} remaining)`);
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
      // Don't kill extension if per-session grace is holding tab bindings
      if (this._sessionGrace.size > 0) {
        debugLogger(`Server grace expired but ${this._sessionGrace.size} per-session grace(s) active — keeping extension`);
        return;
      }
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
    this._extensionConnection.onregistryresponse = this._sidebandRegistry.handleRegistryResponse.bind(this._sidebandRegistry);
    this._extensionConnection.onlogmessage = (msg) => {
      serverLog(`ext:${msg.channel || 'unknown'}`, msg.message || '');
    };
    this._extensionConnectionPromise.resolve();
    this._extensionConnection.onclose = this._handleExtensionClose.bind(this);

    // Collect sessions that need recovery (those that went through Target.setAutoAttach)
    const sessionsToRecover = [...this._clients.values()]
      .filter(s => s.cdpSessionId != null)
      .map(s => ({ sessionId: s.sessionId, cdpSessionId: s.cdpSessionId! }));

    if (sessionsToRecover.length > 0) {
      this._extensionConnection.send('recoverSessions', { sessions: sessionsToRecover }, { timeout: this._extensionCommandTimeout }).then(
        (results: Array<{ sessionId: string; tabId?: number; targetInfo?: any; success: boolean; error?: string }>) => {
          for (const result of results) {
            const session = this._clients.get(result.sessionId);
            if (!session)
              continue;
            if (result.success) {
              session.targetInfo = result.targetInfo;
            } else {
              // Tab is gone and URL fallback failed — close the zombie session
              debugLogger(`Closing unrecoverable session ${result.sessionId}: ${result.error}`);
              if (session.ws.readyState === ws.OPEN)
                session.ws.close(1000, `Tab lost during recovery: ${result.error}`);
              this._clients.delete(result.sessionId);
            }
          }
          const anySuccess = results.some(r => r.success);
          if (anySuccess) {
            debugLogger('Extension recovery completed');
            this._state = 'connected';
          } else {
            serverLog('critical', 'Extension recovery failed for all sessions');
            this._state = 'disconnected';
            this._closeAllClients('Extension recovery failed');
          }
        },
        (error) => {
          serverLog('critical', `Extension recovery failed: ${error.message}`);
          this._state = 'disconnected';
          this._closeAllClients('Extension recovery failed');
        }
      );
    } else {
      // No sessions need recovery — ready for new sessions
      this._state = 'connected';
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
    this._sidebandRegistry.failPending();
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
    this._extensionConnection.onregistryresponse = this._sidebandRegistry.handleRegistryResponse.bind(this._sidebandRegistry);
    this._extensionConnection.onlogmessage = (msg) => {
      serverLog(`ext:${msg.channel || 'unknown'}`, msg.message || '');
    };
    this._extensionConnectionPromise.resolve();

    // Reconcile dormant sessions against live tabs
    if (this._dormantSessions.size > 0) {
      this._extensionConnection.send('listTabs', {}).then(({ tabs }: any) => {
        const liveTabIds = new Set((tabs as any[]).map((t: any) => t.tabId));
        for (const [sid, d] of this._dormantSessions) {
          if (!liveTabIds.has(d.tabId)) {
            this._dormantSessions.delete(sid);
            debugLogger(`Reconciliation: dormant ${sid} tab ${d.tabId} gone`);
          }
        }
      }).catch(() => { /* extension may not support listTabs */ });
    }
  }

  private _handleExtensionMessage<M extends keyof ExtensionEvents>(method: M, params: ExtensionEvents[M]['params']) {
    switch (method) {
      case 'forwardCDPEvent': {
        const fwdParams = params as ExtensionEvents['forwardCDPEvent']['params'];
        // Route by sessionId directly, then single-client fallback
        let targetSession: ClientSession | undefined;
        if (fwdParams.sessionId)
          targetSession = this._clients.get(fwdParams.sessionId);
        if (!targetSession && this._clients.size === 1)
          targetSession = this._clients.values().next().value;

        // Track URL changes so /sessions reflects the current page
        if (targetSession) {
          if (fwdParams.method === 'Target.targetInfoChanged' && fwdParams.params?.targetInfo)
            targetSession.targetInfo = { ...targetSession.targetInfo, ...fwdParams.params.targetInfo };
          else if (fwdParams.method === 'Page.frameNavigated' && fwdParams.params?.frame && !fwdParams.params.frame.parentId)
            targetSession.targetInfo = { ...targetSession.targetInfo, url: fwdParams.params.frame.url };
        }

        // Translate Page-level download events to Browser-level.
        // Extension's chrome.debugger emits Page.downloadWillBegin/Progress (tab-scoped),
        // but Playwright listens on rootSession for Browser.downloadWillBegin/Progress
        // (crBrowser.ts:107-108). Rename and strip sessionId so crConnection.ts:80
        // routes to rootSession (id='').
        let eventMethod = fwdParams.method;
        let eventSessionId: string | undefined;
        if (fwdParams.method === 'Page.downloadWillBegin') {
          eventMethod = 'Browser.downloadWillBegin';
          eventSessionId = undefined;
          debugLogger('Download event translation: Page.downloadWillBegin → Browser.downloadWillBegin (rootSession)');
        } else if (fwdParams.method === 'Page.downloadProgress') {
          eventMethod = 'Browser.downloadProgress';
          eventSessionId = undefined;
          debugLogger('Download event translation: Page.downloadProgress → Browser.downloadProgress (rootSession)');
        } else {
          // Map cdpSessionId back to the client's cdpSessionId for the CDP response
          eventSessionId = fwdParams.cdpSessionId || targetSession?.cdpSessionId || undefined;
        }

        const message: CDPResponse = {
          sessionId: eventSessionId,
          method: eventMethod,
          params: fwdParams.params
        };
        if (this._state === 'grace') {
          this._bufferEvent(JSON.stringify(message));
        } else if (targetSession) {
          this._sendToClient(targetSession.ws, message);
        }
        break;
      }
      case 'tabClosed': {
        const closedSessionId = (params as any).sessionId as string;
        const closedTabId = (params as any).tabId as number;
        this._dormantSessions.delete(closedSessionId);
        this._sessionGrace.cancel(closedSessionId);
        debugLogger(`tabClosed: session ${closedSessionId} tab ${closedTabId} cleaned up`);
        serverLog('lifecycle', `tabClosed: session ${closedSessionId} tab ${closedTabId} — cleaned up dormant/grace`);

        // Update active session state if the closed tab belongs to it
        const activeSession = this._clients.get(closedSessionId);
        if (activeSession && activeSession.tabId === closedTabId) {
          activeSession.tabId = null;
          activeSession.targetInfo = null;
          serverLog('lifecycle', `tabClosed: active session ${closedSessionId} lost tab ${closedTabId}`);
        } else {
          // Fallback: find any session owning this tab by tabId
          for (const [sid, s] of this._clients) {
            if (s.tabId === closedTabId) {
              s.tabId = null;
              s.targetInfo = null;
              serverLog('lifecycle', `tabClosed: active session ${sid} lost tab ${closedTabId} (by tabId match)`);
              break;
            }
          }
        }
        break;
      }
    }
  }

  private async _handlePlaywrightMessage(message: CDPCommand, sessionId: string): Promise<void> {
    debugLogger('← Client:', `${message.method} (id=${message.id})`);
    const session = this._clients.get(sessionId);
    if (!session) return; // client disconnected mid-flight
    // In CDP protocol, message.sessionId is the CDP child session (iframes, workers)
    const { id, sessionId: cdpSessionId, method, params } = message;
    // Fail-fast: no extension to forward to during extension grace
    if (this._state === 'extensionGrace') {
      this._sendToClient(session.ws, {
        id,
        sessionId: cdpSessionId,
        error: { code: -32000, message: 'Extension reconnecting' }
      });
      return;
    }
    try {
      const result = await this._handleCDPCommand(method, params, cdpSessionId, sessionId);
      this._sendToClient(session.ws, { id, sessionId: cdpSessionId, result });
    } catch (e) {
      debugLogger('Error in the extension:', e);
      this._sendToClient(session.ws, {
        id,
        sessionId: cdpSessionId,
        error: { message: (e as Error).message }
      });
    }
  }

  private async _handleCDPCommand(method: string, params: any, cdpSessionId: string | undefined, sessionId: string): Promise<any> {
    switch (method) {
      case 'Browser.getVersion': {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        };
      }
      case 'Browser.setDownloadBehavior': {
        // Translate browser-level → page-level (chrome.debugger is tab-scoped).
        // Page.setDownloadBehavior is deprecated but functional with chrome.debugger.
        // Strip downloadPath (WSL path, Chrome can't resolve it) and browserContextId
        // (not relevant for Page domain). Add eventsEnabled to ensure Page-level
        // download events fire (Page.downloadWillBegin/Progress), which the relay
        // translates to Browser.downloadWillBegin/Progress above.
        const pageParams: Record<string, any> = {
          behavior: params.behavior,
          eventsEnabled: true,
        };
        this._downloadBehavior = { behavior: pageParams.behavior as string, eventsEnabled: true };
        for (const client of this._clients.values()) {
          if (client.tabId != null && client.cdpSessionId) {
            this._forwardToExtension('Page.setDownloadBehavior', pageParams, client.cdpSessionId, client.sessionId).catch(e => {
              debugLogger(`Failed to set download behavior for session ${client.sessionId}: ${e.message}`);
            });
          }
        }
        return {};
      }
      case 'Target.setAutoAttach': {
        // Forward child session handling.
        if (cdpSessionId)
          break;

        // If session was restored from per-session grace, it already has tab state.
        // Return cached targetInfo instead of asking extension for a new tab.
        {
          const session = this._clients.get(sessionId);
          if (session?.targetInfo && session.tabId != null) {
            debugLogger('Returning cached target info for graced session');
            session.cdpSessionId = session.cdpSessionId ?? `session-${sessionId}`;
            this._sendToClient(session.ws, {
              method: 'Target.attachedToTarget',
              params: {
                sessionId: session.cdpSessionId,
                targetInfo: { ...session.targetInfo, attached: true },
                waitingForDebugger: false
              }
            });
            return {};
          }
        }

        // Check if session already has a tab binding (from dormant recovery
        // or prior sideband attachTab call).
        const preSession = this._clients.get(sessionId);
        if (preSession?.tabId != null) {
          // Re-attach to the known tab (dormant recovery path)
          const attachResult = await this._extensionConnection!.send('attachToTab', { sessionId, tabId: preSession.tabId } as any, { timeout: this._extensionCommandTimeout });
          const session = this._clients.get(sessionId);
          if (!session) return {};
          if (attachResult.bumpedSessionId)
            this._notifyBumpedClient(attachResult.bumpedSessionId, sessionId, attachResult.tabId);
          session.targetInfo = attachResult.targetInfo;
          session.tabId = attachResult.tabId ?? preSession.tabId;
          this._sendTabAttached(session);
          return {};
        }

        // Deferred tab creation: new session with no tab binding.
        // Don't create a tab now — let the first tool that needs a tab
        // trigger creation via ensureTab() → sideband POST /tabs/create.
        // This gives agents a chance to list tabs and attach to existing
        // ones (e.g., dormant tabs from a previous session) before any
        // default about:blank tab is created.
        debugLogger(`Deferring tab creation for new session ${sessionId}`);
        return { };
      }
      case 'Target.getTargetInfo': {
        const session = this._clients.get(sessionId);
        return session?.targetInfo;
      }
    }
    return await this._forwardToExtension(method, params, cdpSessionId, sessionId);
  }

  private async _forwardToExtension(method: string, params: any, cdpSessionId: string | undefined, sessionId: string): Promise<any> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    // Strip the top-level cdpSessionId — it only exists between relay and Playwright client.
    // Child sessions (iframes, workers) have their own cdpSessionId that passes through.
    const session = this._clients.get(sessionId);
    if (session?.cdpSessionId === cdpSessionId)
      cdpSessionId = undefined;
    return await this._extensionConnection.send('forwardCDPCommand', { sessionId, cdpSessionId, method, params });
  }

  /**
   * Send Target.attachedToTarget event to a Playwright client, notifying it
   * that a tab is now available. Called when a tab is assigned to a session
   * that previously had none (deferred tab creation).
   */
  private _sendTabAttached(session: ClientSession): void {
    if (!session.ws || !session.targetInfo)
      return;
    session.cdpSessionId = session.cdpSessionId ?? `session-${session.sessionId}`;
    debugLogger(`Sending Target.attachedToTarget for session ${session.sessionId} (tab ${session.tabId})`);
    this._sendToClient(session.ws, {
      method: 'Target.attachedToTarget',
      params: {
        sessionId: session.cdpSessionId,
        targetInfo: { ...session.targetInfo, attached: true },
        waitingForDebugger: false,
      }
    });
    // Forward cached download behavior to the newly attached tab
    if (this._downloadBehavior && session.tabId != null && session.cdpSessionId) {
      this._forwardToExtension('Page.setDownloadBehavior', this._downloadBehavior, session.cdpSessionId, session.sessionId).catch(e => {
        debugLogger(`Failed to set download behavior on new tab for session ${session.sessionId}: ${e.message}`);
      });
    }
  }

  private _notifyBumpedClient(bumpedSessionId: string, newSessionId: string, tabId: number): void {
    const bumpedSession = this._clients.get(bumpedSessionId);
    if (bumpedSession) {
      serverLog('session', `bumped: ${bumpedSessionId} displaced by ${newSessionId} on tab ${tabId}`);
      this._sendToClient(bumpedSession.ws, {
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: bumpedSession.cdpSessionId,
          targetId: bumpedSession.targetInfo?.targetId,
          reason: `Session displaced by ${newSessionId} on tab ${tabId}`,
        }
      });
      // Clear the bumped client's CDP session so it can re-attach elsewhere
      bumpedSession.cdpSessionId = null;
      bumpedSession.targetInfo = null;
      bumpedSession.tabId = null;
    }
  }

  // --- Extension relay commands (for MCP tools) ---

  async listTabs(): Promise<any> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    return await this._extensionConnection.send('listTabs', {} as any, { timeout: this._extensionCommandTimeout });
  }

  async createTab(sessionId: string, url?: string): Promise<any> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    const result = await this._extensionConnection.send('createTab', { sessionId, url } as any, { timeout: this._extensionCommandTimeout });
    // Update the ClientSession if it already exists
    const session = this._clients.get(sessionId);
    if (session) {
      session.tabId = result.tabId ?? null;
      session.targetInfo = result.targetInfo ?? { type: 'page', url: result.url ?? url ?? '', title: '' };
      session.cdpSessionId = result.cdpSessionId ?? session.cdpSessionId;
      // Notify Playwright about the new tab — needed for deferred tab creation
      // where Target.setAutoAttach didn't create a tab initially.
      this._sendTabAttached(session);
    }
    return result;
  }

  async attachTab(sessionId: string, tabId: number): Promise<any> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    const result = await this._extensionConnection.send('attachToTab', { sessionId, tabId } as any, { timeout: this._extensionCommandTimeout });
    // Notify bumped client
    if (result.bumpedSessionId)
      this._notifyBumpedClient(result.bumpedSessionId, sessionId, tabId);
    // Update the ClientSession if it already exists
    const session = this._clients.get(sessionId);
    if (session) {
      // Self-detach: if this session is switching from one tab to another,
      // send Target.detachedFromTarget for the OLD page to the attaching
      // client's own WS. Without this, Playwright's old CRPage becomes a
      // zombie — dead CDP connection, still _currentTab, hangs serialize().
      if (session.tabId !== null && session.tabId !== tabId && session.cdpSessionId) {
        serverLog('session', `self-detach: ${sessionId} leaving tab ${session.tabId} for tab ${tabId}`);
        this._sendToClient(session.ws, {
          method: 'Target.detachedFromTarget',
          params: {
            sessionId: session.cdpSessionId,
            targetId: session.targetInfo?.targetId,
            reason: `Session ${sessionId} switching from tab ${session.tabId} to tab ${tabId}`,
          }
        });
      }
      session.tabId = result.tabId ?? null;
      session.targetInfo = result.targetInfo ?? null;
      if (result.cdpSessionId)
        session.cdpSessionId = result.cdpSessionId;
      // Notify Playwright about the attached tab — needed for deferred tab creation
      // where Target.setAutoAttach didn't create a tab initially.
      this._sendTabAttached(session);
    }
    return result;
  }

  /** Active sessions snapshot for diagnostics. */
  activeSessions(): Array<{ sessionId: string; cdpSessionId: string | null; tab: { tabId: number; url: string } | null; status?: string }> {
    const active = [...this._clients.values()].map(s => ({
      sessionId: s.sessionId,
      cdpSessionId: s.cdpSessionId,
      tab: s.tabId != null ? {
        tabId: s.tabId,
        url: s.targetInfo?.url ?? '',
      } : null,
      status: 'active',
    }));
    const dormant = [...this._dormantSessions.values()].map(d => ({
      sessionId: d.sessionId,
      cdpSessionId: null,
      tab: { tabId: d.tabId, url: d.targetInfo?.url ?? '' },
      status: 'dormant',
    }));
    return [...active, ...dormant];
  }

  get dormantSessionCount(): number {
    return this._dormantSessions.size;
  }

  private _sendToClient(targetWs: WebSocket, message: CDPResponse): void {
    debugLogger('→ Client:', `${message.method ?? `response(id=${message.id})`}`);
    if (targetWs.readyState === ws.OPEN)
      targetWs.send(JSON.stringify(message));
  }

}

function windowsToWslPath(winPath: string): string {
  return winPath
      .replace(/^([A-Za-z]):\\/, (_: string, d: string) => `/mnt/${d.toLowerCase()}/`)
      .replace(/\\/g, '/');
}
