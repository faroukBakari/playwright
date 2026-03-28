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
 * CDP command interpretation and extension forwarding.
 * Owns: handleMessage, _handleCDPCommand, _forwardToExtension,
 *       sendTabAttached, notifyBumpedClient.
 */

import { debug } from '../utilsBundle';
import { serverLog } from './log';
import type { WebSocket } from '../utilsBundle';
import type { ExtensionConnection } from './extensionConnection';
import type { ClientSession, CDPCommand, CDPResponse, RelayState } from './cdpRelayTypes';

const debugLogger = debug('pw:mcp:relay');

export interface CommandRouterDeps {
  getClient(sessionId: string): ClientSession | undefined;
  getExtensionConnection(): ExtensionConnection | null;
  getState(): RelayState;
  getExtensionCommandTimeout(): number;
  getDownloadsPath(): string | undefined;
  sendToClient(targetWs: WebSocket, message: CDPResponse): void;
  bufferEvent(data: string): void;
}

export class CDPCommandRouter {
  private readonly _deps: CommandRouterDeps;

  constructor(deps: CommandRouterDeps) {
    this._deps = deps;
  }

  async handleMessage(message: CDPCommand, sessionId: string): Promise<void> {
    debugLogger('← Client:', `${message.method} (id=${message.id})`);
    const session = this._deps.getClient(sessionId);
    if (!session) return; // client disconnected mid-flight
    // In CDP protocol, message.sessionId is the CDP child session (iframes, workers)
    const { id, sessionId: cdpSessionId, method, params } = message;
    // Fail-fast: no extension to forward to during extension grace
    if (this._deps.getState() === 'extensionGrace') {
      this._deps.sendToClient(session.ws, {
        id,
        sessionId: cdpSessionId,
        error: { code: -32000, message: 'Extension reconnecting' }
      });
      return;
    }
    try {
      const result = await this._handleCDPCommand(method, params, cdpSessionId, sessionId);
      this._deps.sendToClient(session.ws, { id, sessionId: cdpSessionId, result });
    } catch (e) {
      debugLogger('Error in the extension:', e);
      this._deps.sendToClient(session.ws, {
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
        // Browser-domain commands can't go through tab-scoped chrome.debugger.
        // Store the params and send Page.setDownloadBehavior after tab attachment.
        const downloadPath = this._deps.getDownloadsPath() || params?.downloadPath;
        serverLog('download', `Browser.setDownloadBehavior intercepted: behavior=${params?.behavior}, incomingPath=${params?.downloadPath || '(none)'}, overridePath=${this._deps.getDownloadsPath() || '(none)'}, effectivePath=${downloadPath || '(none)'}, sessionId=${sessionId}`);
        const session = this._deps.getClient(sessionId);
        if (session)
          session.downloadBehavior = { behavior: params?.behavior, downloadPath };
        return {};
      }
      case 'Target.setAutoAttach': {
        // Forward child session handling.
        if (cdpSessionId)
          break;

        // If session was restored from per-session grace, it already has tab state.
        // Return cached targetInfo instead of asking extension for a new tab.
        {
          const session = this._deps.getClient(sessionId);
          if (session?.targetInfo && session.tabId != null) {
            debugLogger('Returning cached target info for graced session');
            session.cdpSessionId = session.cdpSessionId ?? `session-${sessionId}`;
            this._deps.sendToClient(session.ws, {
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
        const preSession = this._deps.getClient(sessionId);
        if (preSession?.tabId != null) {
          // Re-attach to the known tab (dormant recovery path)
          const attachResult = await this._deps.getExtensionConnection()!.send('attachToTab', { sessionId, tabId: preSession.tabId } as any, { timeout: this._deps.getExtensionCommandTimeout() });
          const session = this._deps.getClient(sessionId);
          if (!session) return {};
          if (attachResult.bumpedSessionId)
            this.notifyBumpedClient(attachResult.bumpedSessionId, sessionId, attachResult.tabId);
          session.targetInfo = attachResult.targetInfo;
          session.tabId = attachResult.tabId ?? preSession.tabId;
          this.sendTabAttached(session);
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
        const session = this._deps.getClient(sessionId);
        return session?.targetInfo;
      }
    }
    return await this._forwardToExtension(method, params, cdpSessionId, sessionId);
  }

  private async _forwardToExtension(method: string, params: any, cdpSessionId: string | undefined, sessionId: string): Promise<any> {
    if (!this._deps.getExtensionConnection())
      throw new Error('Extension not connected');
    // Strip the top-level cdpSessionId — it only exists between relay and Playwright client.
    // Child sessions (iframes, workers) have their own cdpSessionId that passes through.
    const session = this._deps.getClient(sessionId);
    if (session?.cdpSessionId === cdpSessionId)
      cdpSessionId = undefined;
    return await this._deps.getExtensionConnection()!.send('forwardCDPCommand', { sessionId, cdpSessionId, method, params });
  }

  /**
   * Send Target.attachedToTarget event to a Playwright client, notifying it
   * that a tab is now available. Called when a tab is assigned to a session
   * that previously had none (deferred tab creation).
   */
  sendTabAttached(session: ClientSession): void {
    if (!session.ws || !session.targetInfo)
      return;
    session.cdpSessionId = session.cdpSessionId ?? `session-${session.sessionId}`;
    debugLogger(`Sending Target.attachedToTarget for session ${session.sessionId} (tab ${session.tabId})`);
    this._deps.sendToClient(session.ws, {
      method: 'Target.attachedToTarget',
      params: {
        sessionId: session.cdpSessionId,
        targetInfo: { ...session.targetInfo, attached: true },
        waitingForDebugger: false,
      }
    });
    // Send deferred Page.setDownloadBehavior now that we have an attached tab.
    // Browser.setDownloadBehavior can't go through tab-scoped chrome.debugger,
    // so we convert to the Page-domain equivalent after tab attachment.
    if (session.downloadBehavior && this._deps.getExtensionConnection()) {
      const { behavior, downloadPath } = session.downloadBehavior;
      serverLog('download', `Sending Page.setDownloadBehavior: behavior=${behavior}, downloadPath=${downloadPath || '(none)'}, sessionId=${session.sessionId}`);
      this._deps.getExtensionConnection()!.send('forwardCDPCommand', {
        sessionId: session.sessionId,
        method: 'Page.setDownloadBehavior',
        params: { behavior, downloadPath },
      }).then(
        result => serverLog('download', `Page.setDownloadBehavior OK: sessionId=${session.sessionId}, result=${JSON.stringify(result)}`),
        err => serverLog('download', `Page.setDownloadBehavior FAILED: sessionId=${session.sessionId}, error=${err.message}`)
      );
    }
  }

  notifyBumpedClient(bumpedSessionId: string, newSessionId: string, tabId: number): void {
    const bumpedSession = this._deps.getClient(bumpedSessionId);
    if (bumpedSession) {
      serverLog('session', `bumped: ${bumpedSessionId} displaced by ${newSessionId} on tab ${tabId}`);
      this._deps.sendToClient(bumpedSession.ws, {
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
}
