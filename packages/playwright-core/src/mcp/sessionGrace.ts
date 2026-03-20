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

import { debug } from '../utilsBundle';

const debugLogger = debug('pw:mcp:relay:grace');

export interface GracedSession {
  sessionId: string;
  cdpSessionId: string | null;
  targetInfo: any | null;
  tabId: number | null;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionGraceManager {
  private _graced = new Map<string, GracedSession>();
  private readonly _ttl: number;

  constructor(ttl: number) {
    this._ttl = ttl;
  }

  /** Move a disconnected session into grace. Returns true if entered grace. */
  enter(sessionId: string, cdpSessionId: string | null, targetInfo: any | null, tabId: number | null, onExpire: (sessionId: string) => void): boolean {
    // Only grace sessions that have a tab binding worth preserving
    if (cdpSessionId == null) return false;
    this.cancel(sessionId); // clear any existing grace for this sessionId
    const timer = setTimeout(() => {
      this._graced.delete(sessionId);
      onExpire(sessionId);
    }, this._ttl);
    this._graced.set(sessionId, { sessionId, cdpSessionId, targetInfo, tabId, timer });
    debugLogger(`Session ${sessionId} entered per-session grace (${this._ttl}ms)`);
    return true;
  }

  /** Cancel grace for a session. Returns the graced session data or null. */
  cancel(sessionId: string): GracedSession | null {
    const graced = this._graced.get(sessionId);
    if (!graced) return null;
    clearTimeout(graced.timer);
    this._graced.delete(sessionId);
    debugLogger(`Session ${sessionId} grace cancelled`);
    return graced;
  }

  /** Check if a sessionId is in grace. */
  has(sessionId: string): boolean {
    return this._graced.has(sessionId);
  }

  /** Get graced session data without removing it. */
  get(sessionId: string): GracedSession | null {
    return this._graced.get(sessionId) ?? null;
  }

  /** Cancel all graced sessions, calling onExpire for each. */
  cancelAll(onExpire?: (sessionId: string) => void): void {
    for (const [sessionId, graced] of this._graced) {
      clearTimeout(graced.timer);
      if (onExpire) onExpire(sessionId);
    }
    this._graced.clear();
  }

  /** Number of sessions currently in grace. */
  get size(): number {
    return this._graced.size;
  }
}
