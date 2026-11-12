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

import { serverLog } from './log';

import type { CDPResponse, ClientSession } from './cdpRelayTypes';

export type BoundTab = { tabId: number; targetInfo: any };

/** The tab an extension attach or create reply names, or none when it names no tab. */
export function boundTabFrom(reply: { tabId?: number; targetInfo?: any } | undefined): BoundTab | null {
  return reply?.tabId != null ? { tabId: reply.tabId, targetInfo: reply.targetInfo ?? null } : null;
}

export interface SessionBindingDeps {
  sendToClient(session: ClientSession, message: CDPResponse): void;
}

/**
 * Sole writer of a session's tab binding and sole emitter of the target
 * attach and detach messages a Playwright client builds its pages from.
 * The previous target is always retired before the next one is announced,
 * so the per-session CDP session id is never live twice.
 */
export class SessionBinding {
  private readonly _deps: SessionBindingDeps;

  constructor(deps: SessionBindingDeps) {
    this._deps = deps;
  }

  /** Move a session to another tab, or to none. A no-op when it already is on that target. */
  apply(session: ClientSession, next: BoundTab | null, reason: string): void {
    if (next && session.tabId === next.tabId && session.targetInfo?.targetId === next.targetInfo?.targetId)
      return;
    if (session.tabId != null) {
      serverLog('session', `binding: ${session.sessionId} leaves tab ${session.tabId} (${reason})`);
      // Without target info the tab was never announced, so there is no target to retire.
      if (session.targetInfo) {
        this._deps.sendToClient(session, {
          method: 'Target.detachedFromTarget',
          params: {
            sessionId: session.cdpSessionId,
            targetId: session.targetInfo.targetId,
            reason,
          }
        });
      }
      session.tabId = null;
      session.targetInfo = null;
    }
    if (!next)
      return;
    session.tabId = next.tabId;
    session.targetInfo = next.targetInfo;
    serverLog('session', `binding: ${session.sessionId} bound to tab ${next.tabId} (${reason})`);
    this.announce(session);
  }

  /** Tell the client about the target a session is already bound to. */
  announce(session: ClientSession): void {
    if (session.tabId == null || !session.targetInfo)
      return;
    session.cdpSessionId ??= `session-${session.sessionId}`;
    this._deps.sendToClient(session, {
      method: 'Target.attachedToTarget',
      params: {
        sessionId: session.cdpSessionId,
        targetInfo: { ...session.targetInfo, attached: true },
        waitingForDebugger: false,
      }
    });
  }

  /** Refresh descriptive fields of the bound target, such as its URL. */
  noteTargetInfo(session: ClientSession, patch: object): void {
    if (session.tabId == null)
      return;
    session.targetInfo = { ...session.targetInfo, ...patch };
  }
}
