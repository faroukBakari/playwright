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
 * CDP command interpretation, extension forwarding in both directions, and
 * the tab commands (create, attach, recycle) that change a session's binding.
 */

import { debug } from '../utilsBundle';
import { serverLog } from './log';
import { boundTabFrom } from './sessionBinding';
import type { ExtensionConnection } from './extensionConnection';
import type { ExtensionEvents } from './protocol';
import type { ClientSession, CDPCommand, CDPResponse, RelayState } from './cdpRelayTypes';
import type { SessionBinding } from './sessionBinding';

const debugLogger = debug('pw:mcp:relay');

// The largest request budget a tool call may ask for (600 s) plus the client buffer (5 s).
const FORWARDED_COMMAND_CEILING_MS = 605_000;

export interface CommandRouterDeps {
  getClient(sessionId: string): ClientSession | undefined;
  getExtensionConnection(): ExtensionConnection | null;
  getExtensionMismatch(): string | null;
  getState(): RelayState;
  getExtensionCommandTimeout(): number;
  sendToClient(session: ClientSession, message: CDPResponse): void;
  bufferEvent(data: string): void;
  binding: SessionBinding;
}

export class CDPCommandRouter {
  private readonly _deps: CommandRouterDeps;

  constructor(deps: CommandRouterDeps) {
    this._deps = deps;
  }

  async handleMessage(message: CDPCommand, sessionId: string): Promise<void> {
    debugLogger('← Client:', `${message.method} (id=${message.id})`);
    const session = this._deps.getClient(sessionId);
    if (!session)
      return; // client disconnected mid-flight
    // In CDP protocol, message.sessionId is the CDP child session (iframes, workers)
    const { id, sessionId: cdpSessionId, method, params } = message;
    // Fail-fast: no extension to forward to during extension grace
    if (this._deps.getState() === 'extensionGrace') {
      this._deps.sendToClient(session, {
        id,
        sessionId: cdpSessionId,
        error: { code: -32000, message: 'Extension reconnecting' }
      });
      return;
    }
    try {
      const result = await this._handleCDPCommand(method, params, cdpSessionId, sessionId);
      this._deps.sendToClient(session, { id, sessionId: cdpSessionId, result });
    } catch (e) {
      debugLogger('Error in the extension:', e);
      this._deps.sendToClient(session, {
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
        // Chrome's extension debugger rejects download behavior at every scope; downloads use the chrome.downloads API.
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
            this._deps.binding.announce(session);
            return {};
          }
        }

        // Check if session already has a tab binding (from dormant recovery
        // or prior sideband attachTab call).
        const preSession = this._deps.getClient(sessionId);
        if (preSession?.tabId != null) {
          // Re-attach to the known tab (dormant recovery path)
          const tabId = preSession.tabId;
          const attachResult = await this._deps.getExtensionConnection()!.send('attachToTab', { sessionId, tabId }, { timeout: this._deps.getExtensionCommandTimeout() });
          const session = this._deps.getClient(sessionId);
          if (!session)
            return {};
          this._deps.binding.apply(session, boundTabFrom({ ...attachResult, tabId: attachResult.tabId ?? tabId }), `re-attached remembered tab ${tabId}`);
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

  /**
   * Stop whatever is driving a session's page: retire its target, cycle the
   * debugger attachment on the same tab, then announce the target again.
   * A failure after the detach leaves the session unbound.
   */
  async recycleTab(sessionId: string, options?: { timeout?: number }): Promise<any> {
    const extension = this._currentExtension();
    const session = this._deps.getClient(sessionId);
    if (!session || session.tabId == null)
      throw new Error(`Session ${sessionId} has no tab to recycle`);
    const tabId = session.tabId;
    const timeout = options?.timeout ?? this._deps.getExtensionCommandTimeout();
    this._deps.binding.apply(session, null, `recycling tab ${tabId}`);
    await extension.send('detachTab', { sessionId }, { timeout });
    const result = await extension.send('attachToTab', { sessionId, tabId }, { timeout });
    this._deps.binding.apply(session, boundTabFrom(result), `recycled tab ${tabId}`);
    serverLog('session', `recycle: ${sessionId} re-attached tab ${session.tabId}`);
    return result;
  }

  async createTab(sessionId: string, url?: string, options?: { timeout?: number }): Promise<any> {
    const result = await this._currentExtension().send('createTab', { sessionId, url }, { timeout: options?.timeout ?? this._deps.getExtensionCommandTimeout() });
    const session = this._deps.getClient(sessionId);
    if (session) {
      const targetInfo = result.targetInfo ?? { type: 'page', url: result.url ?? url ?? '', title: '' };
      this._deps.binding.apply(session, boundTabFrom({ tabId: result.tabId, targetInfo }), `created tab ${result.tabId}`);
    }
    return result;
  }

  /**
   * Attach a session to an existing tab. The extension reports the tab the
   * session leaves and the session it displaces before it answers, so the
   * reply only has to bind the new tab.
   */
  async attachTab(sessionId: string, tabId: number, options?: { timeout?: number }): Promise<any> {
    const result = await this._currentExtension().send('attachToTab', { sessionId, tabId }, { timeout: options?.timeout ?? this._deps.getExtensionCommandTimeout() });
    const session = this._deps.getClient(sessionId);
    if (session)
      this._deps.binding.apply(session, boundTabFrom(result), `attached tab ${tabId}`);
    return result;
  }

  /** Deliver a tab-stamped extension event to the session bound to that tab. */
  forwardEvent(event: ExtensionEvents['forwardCDPEvent']['params']): void {
    // No client is connected during grace: events wait for the one that reconnects.
    if (this._deps.getState() === 'grace') {
      this._deps.bufferEvent(JSON.stringify({ sessionId: event.cdpSessionId || undefined, method: event.method, params: event.params }));
      return;
    }
    // An event of a tab the session no longer owns must not reach its current page.
    const session = this._deps.getClient(event.sessionId);
    if (!session || session.tabId !== event.tabId)
      return;

    // Track URL changes so /sessions reflects the current page
    if (event.method === 'Target.targetInfoChanged' && event.params?.targetInfo)
      this._deps.binding.noteTargetInfo(session, event.params.targetInfo);
    else if (event.method === 'Page.frameNavigated' && event.params?.frame && !event.params.frame.parentId)
      this._deps.binding.noteTargetInfo(session, { url: event.params.frame.url });

    if (event.method === 'Page.downloadWillBegin' || event.method === 'Page.downloadProgress')
      serverLog('download', `CDP event ${event.method}: sessionId=${session.sessionId}, ${JSON.stringify(event.params)}`);

    this._deps.sendToClient(session, {
      sessionId: event.cdpSessionId || session.cdpSessionId || undefined,
      method: event.method,
      params: event.params
    });
  }

  private async _forwardToExtension(method: string, params: any, cdpSessionId: string | undefined, sessionId: string): Promise<any> {
    const extension = this._currentExtension();
    const session = this._deps.getClient(sessionId);
    if (session?.tabId == null)
      throw new Error(`No tab attached to session ${sessionId}`);
    // Strip the top-level cdpSessionId — it only exists between relay and Playwright client.
    // Child sessions (iframes, workers) have their own cdpSessionId that passes through.
    if (session.cdpSessionId === cdpSessionId)
      cdpSessionId = undefined;
    return await extension.send('forwardCDPCommand', { sessionId, tabId: session.tabId, cdpSessionId, method, params }, { timeout: FORWARDED_COMMAND_CEILING_MS });
  }

  private _currentExtension(): ExtensionConnection {
    const extension = this._deps.getExtensionConnection();
    if (!extension)
      throw new Error('Extension not connected');
    const mismatch = this._deps.getExtensionMismatch();
    if (mismatch)
      throw new Error(mismatch);
    return extension;
  }
}
