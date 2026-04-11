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
import { type RelayState, type ClientSession, type DormantSession, type CDPRelayOptions, type CDPResponse } from './cdpRelayTypes';
import { CDPCommandRouter } from './cdpCommandRouter';
import { CDPRelayStateMachine, DEFAULT_GRACE_TTL, DEFAULT_EXTENSION_GRACE_TTL, DEFAULT_GRACE_BUFFER_MAX_BYTES } from './cdpRelayStateMachine';

export { type RelayState, type ClientSession, type CDPRelayOptions } from './cdpRelayTypes';

const debugLogger = debug('pw:mcp:relay');

const DEFAULT_EXTENSION_COMMAND_TIMEOUT = 10_000;
const DEFAULT_MAX_CONCURRENT_CLIENTS = 4;

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

  // Grace / state-machine (extracted)
  private _stateMachine!: CDPRelayStateMachine;
  private readonly _extensionCommandTimeout: number;

  // Playwright reconnection retry counter
  private _playwrightReconnectCount = 0;
  private readonly _maxPlaywrightReconnects = 3;

  // Download path override — browser-side path for Browser.setDownloadBehavior
  private readonly _downloadsPath: string | undefined;

  // Sideband HTTP registry (extracted)
  private _sidebandRegistry: SidebandRegistry;

  // CDP command router (extracted)
  private _commandRouter!: CDPCommandRouter;

  // Sessions marked for immediate cleanup — skip per-session grace on WS close.
  // Set by the server layer when SESSION_IDLE_TTL fires (MCP session permanently disposed).
  private _immediateCleanupSessions = new Set<string>();

  constructor(server: http.Server, _browserChannel: string, options?: CDPRelayOptions) {
    this._wsHost = addressToString(server.address(), { protocol: 'ws' });
    this._extensionCommandTimeout = options?.extensionCommandTimeout ?? DEFAULT_EXTENSION_COMMAND_TIMEOUT;
    this._maxConcurrentClients = options?.maxConcurrentClients ?? DEFAULT_MAX_CONCURRENT_CLIENTS;
    this._downloadsPath = options?.downloadsPath;
    this._sessionGrace = new SessionGraceManager(options?.sessionGraceTTL ?? 0);
    this._stateMachine = new CDPRelayStateMachine({
      graceTTL: options?.graceTTL ?? DEFAULT_GRACE_TTL,
      extensionGraceTTL: options?.extensionGraceTTL ?? DEFAULT_EXTENSION_GRACE_TTL,
      graceBufferMaxBytes: options?.graceBufferMaxBytes ?? DEFAULT_GRACE_BUFFER_MAX_BYTES,
      callbacks: {
        onServerGraceExpired: (_hasPerSessionGrace: boolean) => {
          this._extensionConnection?.sendRaw({ type: 'registry:serverDown' });
          this._closeExtensionConnection('Grace period expired');
        },
        onExtensionGraceExpired: () => {
          this._closeAllClients('Extension grace expired');
        },
      },
      getPerSessionGraceCount: () => this._sessionGrace.size,
    });

    const uuid = crypto.randomUUID();
    this._cdpPath = `/cdp/${uuid}`;
    this._extensionPath = `/extension/${uuid}`;

    this._resetExtensionConnection();
    this._sidebandRegistry = new SidebandRegistry(() => this._extensionConnection);
    this._sidebandRegistry.installHTTP(server);
    this._commandRouter = new CDPCommandRouter({
      getClient: (sid) => this._clients.get(sid),
      getExtensionConnection: () => this._extensionConnection,
      getState: () => this._stateMachine.state,
      getExtensionCommandTimeout: () => this._extensionCommandTimeout,
      getDownloadsPath: () => this._downloadsPath,
      sendToClient: (targetWs, msg) => this._sendToClient(targetWs, msg),
      bufferEvent: (data) => this._stateMachine.bufferEvent(data),
    });
    installRelayHTTPEndpoints(server, this);
    this._wss = new wsServer({ server });
    this._wss.on('connection', this._onConnection.bind(this));
  }

  get state(): RelayState {
    return this._stateMachine.state;
  }

  // Pass-through accessors for test compatibility (tests access via `as any`)
  get _graceBuffer() { return this._stateMachine.graceBuffer; }
  set _graceBuffer(v: { data: string; size: number }[]) { this._stateMachine.graceBuffer = v; }
  get _graceBufferBytes() { return this._stateMachine.graceBufferBytes; }
  set _graceBufferBytes(v: number) { this._stateMachine.graceBufferBytes = v; }

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
    this._sessionGrace.cancelAll();
    this._playwrightReconnectCount = 0;
    this._stateMachine.reset();
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
    this._stateMachine.cancelGrace();
    this._stateMachine.cancelExtensionGrace();
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
    serverLog('session', `connect: sessionId=${sessionId} clients=${this._clients.size}/${this._maxConcurrentClients} state=${this._stateMachine.state}`);
    // Per-session grace: same sessionId reconnecting within TTL.
    // Checked FIRST — per-session grace has the correct session-specific
    // data (cdpSessionId, targetInfo, tabId), whereas server grace only
    // knows about the _lastDisconnectedSession (wrong for multi-session).
    const gracedSession = this._sessionGrace.cancel(sessionId);
    if (gracedSession) {
      serverLog('session', `reconnect via grace: sessionId=${sessionId} tabId=${gracedSession.tabId ?? 'null'}`);
      // Also cancel server grace if active — a session is back
      if (this._stateMachine.state === 'grace') {
        this._stateMachine.cancelGrace();
        this._stateMachine.flushGraceBuffer((data) => {
          if (clientWs.readyState === ws.OPEN) clientWs.send(data);
        });
      }
      const session: ClientSession = {
        sessionId,
        ws: clientWs,
        cdpSessionId: gracedSession.cdpSessionId,
        targetInfo: gracedSession.targetInfo,
        tabId: gracedSession.tabId,
        downloadBehavior: null,
      };
      this._clients.set(sessionId, session);
      this._stateMachine.state = 'connected';
      this._installPlaywrightHandlers(clientWs, sessionId);
      return;
    }

    // Dormant: session was graced, debugger detached, but tab still alive
    const dormant = this._dormantSessions.get(sessionId);
    if (dormant) {
      this._dormantSessions.delete(sessionId);
      serverLog('session', `reconnect via dormant: sessionId=${sessionId} tabId=${dormant.tabId}`);
      if (this._stateMachine.state === 'grace') {
        this._stateMachine.cancelGrace();
        this._stateMachine.flushGraceBuffer((data) => {
          if (clientWs.readyState === ws.OPEN) clientWs.send(data);
        });
      }
      const session: ClientSession = {
        sessionId,
        ws: clientWs,
        cdpSessionId: null,
        targetInfo: null,
        tabId: dormant.tabId,
        downloadBehavior: null,
      };
      this._clients.set(sessionId, session);
      this._stateMachine.state = 'connected';
      this._installPlaywrightHandlers(clientWs, sessionId);
      return;
    }

    // During server grace period: accept reconnection, resume last session
    // (fallback for single-session scenarios without per-session grace)
    if (this._stateMachine.state === 'grace') {
      this._playwrightReconnectCount++;
      if (this._playwrightReconnectCount > this._maxPlaywrightReconnects) {
        serverLog('critical', `Playwright reconnect limit exceeded (${this._playwrightReconnectCount}/${this._maxPlaywrightReconnects})`);
        clientWs.close(1008, 'Reconnect limit exceeded');
        this._stateMachine.cancelGrace();
        this._extensionConnection?.sendRaw({ type: 'registry:serverDown' });
        this._closeExtensionConnection('Reconnect limit exceeded');
        this._stateMachine.state = 'disconnected';
        return;
      }
      serverLog('session', `reconnect via server grace: sessionId=${sessionId} attempt=${this._playwrightReconnectCount}/${this._maxPlaywrightReconnects}`);
      const session: ClientSession = {
        sessionId,
        ws: clientWs,
        cdpSessionId: this._lastDisconnectedSession?.cdpSessionId ?? null,
        targetInfo: this._lastDisconnectedSession?.targetInfo ?? null,
        tabId: this._lastDisconnectedSession?.tabId ?? null,
        downloadBehavior: this._lastDisconnectedSession?.downloadBehavior ?? null,
      };
      this._clients.set(sessionId, session);
      this._lastDisconnectedSession = null;
      this._stateMachine.cancelGrace();
      this._stateMachine.flushGraceBuffer((data) => {
        if (clientWs.readyState === ws.OPEN) clientWs.send(data);
      });
      this._stateMachine.state = 'connected';
      this._installPlaywrightHandlers(clientWs, sessionId);
      return;
    }

    // Concurrency cap
    if (this._clients.size >= this._maxConcurrentClients) {
      serverLog('warn', `rejected: sessionId=${sessionId} — concurrent client limit (${this._clients.size}/${this._maxConcurrentClients})`);
      clientWs.close(1008, 'Concurrent client limit reached');
      return;
    }

    // Reset reconnect counter only on transition from disconnected
    if (this._stateMachine.state === 'disconnected')
      this._playwrightReconnectCount = 0;

    const session: ClientSession = {
      sessionId,
      ws: clientWs,
      cdpSessionId: null,
      targetInfo: null,
      tabId: null,
      downloadBehavior: null,
    };
    this._clients.set(sessionId, session);
    this._stateMachine.state = 'connected';
    serverLog('session', `accepted: sessionId=${sessionId} clients=${this._clients.size}/${this._maxConcurrentClients}`);
    this._installPlaywrightHandlers(clientWs, sessionId);
  }

  private _installPlaywrightHandlers(clientWs: WebSocket, sessionId: string): void {
    clientWs.on('message', async data => {
      try {
        const message = JSON.parse(data.toString());
        await this._commandRouter.handleMessage(message, sessionId);
      } catch (error: any) {
        debugLogger(`Error while handling Playwright message\n${data.toString()}\n`, error);
      }
    });
    clientWs.on('close', () => {
      const session = this._clients.get(sessionId);
      if (!session || session.ws !== clientWs) {
        serverLog('session', `WS close (stale): sessionId=${sessionId} found=${!!session} wsMatch=${session?.ws === clientWs} clients=${this._clients.size}/${this._maxConcurrentClients}`);
        return;
      }
      serverLog('session', `WS close: sessionId=${sessionId} cdpSessionId=${session.cdpSessionId ?? 'null'} tabId=${session.tabId ?? 'null'} clients=${this._clients.size}/${this._maxConcurrentClients}`);

      // Remove from active clients
      this._clients.delete(sessionId);
      serverLog('session', `slot freed: sessionId=${sessionId} clients=${this._clients.size}/${this._maxConcurrentClients}`);

      // Check if server layer marked this session for immediate cleanup
      // (SESSION_IDLE_TTL fired — MCP session permanently disposed, no reconnection possible)
      const skipGrace = this._immediateCleanupSessions.has(sessionId);
      if (skipGrace)
        this._immediateCleanupSessions.delete(sessionId);

      // Try per-session grace (preserves tab binding) — unless marked for immediate cleanup
      const enteredGrace = skipGrace ? false : this._sessionGrace.enter(
        sessionId,
        session.cdpSessionId,
        session.targetInfo,
        session.tabId,
        (expiredSessionId: string, gracedData: GracedSession) => {
          // Grace expired — NOW send detachTab
          debugLogger(`Per-session grace expired for ${expiredSessionId}`);
          if (this._extensionConnection) {
            this._extensionConnection.send('detachTab', { sessionId: expiredSessionId }).catch(e => serverLog('warn', `detachTab failed for expired session ${expiredSessionId}`, e));
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

      serverLog('session', `grace: sessionId=${sessionId} entered=${enteredGrace}${skipGrace ? ' (skipped: idle disposal)' : ''} cdpSessionId=${session.cdpSessionId ?? 'null'} tabId=${session.tabId ?? 'null'}`);

      // If session had no tab binding (cdpSessionId null), do immediate cleanup as before
      if (!enteredGrace && session.cdpSessionId != null && this._extensionConnection) {
        this._extensionConnection.send('detachTab', { sessionId }).catch(e => serverLog('warn', `detachTab failed for session ${sessionId}`, e));
      }

      // If in extension grace and all clients gone — immediate disconnected
      if (this._stateMachine.state === 'extensionGrace' && this._clients.size === 0) {
        serverLog('lifecycle', `cascade: all clients gone during extensionGrace, sessionId=${sessionId} triggered transition to disconnected`);
        this._stateMachine.cancelExtensionGrace();
        this._sessionGrace.cancelAll((sid: string, _graced: GracedSession) => {
          if (this._extensionConnection)
            this._extensionConnection.send('detachTab', { sessionId: sid }).catch(e => serverLog('warn', `detachTab failed for session ${sid}`, e));
        });
        this._stateMachine.state = 'disconnected';
        return;
      }

      // Last client: enter server-level grace or go disconnected
      if (this._clients.size === 0) {
        this._lastDisconnectedSession = session;
        if (this._extensionConnection) {
          serverLog('lifecycle', `last client: sessionId=${sessionId} entering=grace`);
          this._stateMachine.enterGrace();
        } else {
          serverLog('lifecycle', `last client: sessionId=${sessionId} entering=disconnected (no extension)`);
          this._sessionGrace.cancelAll();
          this._stateMachine.state = 'disconnected';
        }
      }
      debugLogger(`Session ${sessionId} disconnected (${this._clients.size} remaining)`);
    });
    clientWs.on('error', error => {
      debugLogger('Playwright WebSocket error:', error);
      serverLog('warn', `Playwright WebSocket error for session ${sessionId}`, error);
    });
  }

  private _handleExtensionClose(c: ExtensionConnection, reason: string): void {
    debugLogger('Extension WebSocket closed:', reason, c === this._extensionConnection);
    if (this._extensionConnection !== c)
      return;
    this._resetExtensionConnection();
    if (this._clients.size === 0 || this._stateMachine.state === 'grace') {
      this._stateMachine.cancelGrace();
      this._stateMachine.clearBuffer();
      this._stateMachine.state = 'disconnected';
      this._closeAllClients(`Extension disconnected: ${reason}`);
      return;
    }
    this._stateMachine.enterExtensionGrace();
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
            this._stateMachine.state = 'connected';
          } else {
            serverLog('critical', 'Extension recovery failed for all sessions');
            this._stateMachine.state = 'disconnected';
            this._closeAllClients('Extension recovery failed');
          }
        },
        (error) => {
          serverLog('critical', `Extension recovery failed: ${error.message}`);
          this._stateMachine.state = 'disconnected';
          this._closeAllClients('Extension recovery failed');
        }
      );
    } else {
      // No sessions need recovery — ready for new sessions
      this._stateMachine.state = 'connected';
    }
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
    if (this._stateMachine.state === 'extensionGrace') {
      this._stateMachine.cancelExtensionGrace();
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

        if (fwdParams.method === 'Page.downloadWillBegin' || fwdParams.method === 'Page.downloadProgress')
          serverLog('download', `CDP event ${fwdParams.method}: sessionId=${targetSession?.sessionId || '(unknown)'}, ${JSON.stringify(fwdParams.params)}`);

        // Map cdpSessionId back to the client's cdpSessionId for the CDP response
        const cdpSessionId = fwdParams.cdpSessionId || targetSession?.cdpSessionId || undefined;
        const message: CDPResponse = {
          sessionId: cdpSessionId,
          method: fwdParams.method,
          params: fwdParams.params
        };
        if (this._stateMachine.state === 'grace') {
          this._stateMachine.bufferEvent(JSON.stringify(message));
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

  // --- Extension relay commands (for MCP tools) ---

  async listTabs(options?: { timeout?: number }): Promise<any> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    return await this._extensionConnection.send('listTabs', {} as any, { timeout: options?.timeout ?? this._extensionCommandTimeout });
  }

  async createTab(sessionId: string, url?: string, options?: { timeout?: number }): Promise<any> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    const result = await this._extensionConnection.send('createTab', { sessionId, url } as any, { timeout: options?.timeout ?? this._extensionCommandTimeout });
    // Update the ClientSession if it already exists
    const session = this._clients.get(sessionId);
    if (session) {
      session.tabId = result.tabId ?? null;
      session.targetInfo = result.targetInfo ?? { type: 'page', url: result.url ?? url ?? '', title: '' };
      session.cdpSessionId = result.cdpSessionId ?? session.cdpSessionId;
      // Notify Playwright about the new tab — needed for deferred tab creation
      // where Target.setAutoAttach didn't create a tab initially.
      this._commandRouter.sendTabAttached(session);
    }
    return result;
  }

  async attachTab(sessionId: string, tabId: number, options?: { timeout?: number }): Promise<any> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    serverLog('session', `attachTab: sessionId=${sessionId} tabId=${tabId} clients=${this._clients.size}/${this._maxConcurrentClients} sessionExists=${this._clients.has(sessionId)}`);
    const result = await this._extensionConnection.send('attachToTab', { sessionId, tabId } as any, { timeout: options?.timeout ?? this._extensionCommandTimeout });
    // Notify bumped client
    if (result.bumpedSessionId)
      this._commandRouter.notifyBumpedClient(result.bumpedSessionId, sessionId, tabId);
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
      this._commandRouter.sendTabAttached(session);
    }
    return result;
  }

  async sendCustomCommand(method: string, params: any, options?: { timeout?: number }): Promise<any> {
    if (!this._extensionConnection)
      throw new Error('Extension not connected');
    return await (this._extensionConnection as any).send(method, params, { timeout: options?.timeout ?? 10000 });
  }

  /**
   * Mark a session for immediate cleanup — skip per-session grace on WS close.
   * Called by the server layer when SESSION_IDLE_TTL fires (MCP session permanently
   * disposed). If the session is already in grace, cancel it immediately and detach.
   */
  markForImmediateCleanup(sessionId: string): void {
    // If already in per-session grace, cancel and detach immediately
    const graced = this._sessionGrace.cancel(sessionId);
    if (graced) {
      serverLog('session', `immediate cleanup (already graced): sessionId=${sessionId} tabId=${graced.tabId ?? 'null'}`);
      if (graced.tabId != null && this._extensionConnection)
        this._extensionConnection.send('detachTab', { sessionId }).catch(e => serverLog('warn', `detachTab failed for immediate cleanup ${sessionId}`, e));
      // Do NOT move to dormant — MCP session is permanently gone
      return;
    }
    // Otherwise, mark for the close handler to skip grace
    this._immediateCleanupSessions.add(sessionId);
    serverLog('session', `marked for immediate cleanup: sessionId=${sessionId}`);
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
