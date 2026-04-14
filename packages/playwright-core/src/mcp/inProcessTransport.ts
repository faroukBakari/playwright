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
 * In-process transport bridging Playwright CRConnection ↔ CDP relay.
 * Eliminates the localhost WebSocket loopback — both run in the same Node process.
 */

import { makeWaitForNextTask } from '../utils';
import { debug } from '../utilsBundle';
import { serverLog } from './log';

import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from '../server/transport';
import type { CDPRelayServer } from './cdpRelay';
import type { CDPResponse, CDPCommand } from './cdpRelayTypes';

const debugLogger = debug('pw:mcp:transport');

export class InProcessTransport implements ConnectionTransport {
  onmessage?: (message: ProtocolResponse) => void;
  onclose?: (reason?: string) => void;

  private _relay: CDPRelayServer;
  private _sessionId: string;
  private _handleMessage: ((message: CDPCommand) => Promise<void>) | null = null;
  private _closed = false;
  private readonly _messageWrap: (cb: () => void) => void;

  constructor(relay: CDPRelayServer, sessionId: string) {
    this._relay = relay;
    this._sessionId = sessionId;
    // Same reentrancy guard as WebSocketTransport — prevent relay calling
    // onmessage synchronously in the same call stack as send().
    this._messageWrap = makeWaitForNextTask();

    debugLogger(`<in-process connected> sessionId=${sessionId}`);
    serverLog('transport', `in-process transport created: sessionId=${sessionId}`);

    const { handleMessage } = relay.connectSession(sessionId, {
      send: (message: CDPResponse) => {
        if (this._closed) {
          debugLogger(`<in-process send-after-close> sessionId=${sessionId} method=${message.method ?? `response(id=${message.id})`}`);
          return;
        }
        this._messageWrap(() => {
          if (!this._closed && this.onmessage)
            this.onmessage(message as unknown as ProtocolResponse);
        });
      },
      sendRaw: (data: string) => {
        if (this._closed) return;
        this._messageWrap(() => {
          if (!this._closed && this.onmessage) {
            try {
              this.onmessage(JSON.parse(data) as ProtocolResponse);
            } catch (e) {
              serverLog('warn', `in-process sendRaw parse error: sessionId=${sessionId} error=${(e as Error).message}`);
            }
          }
        });
      },
      close: (_code: number, reason: string) => {
        if (this._closed) return;
        this._closed = true;
        debugLogger(`<in-process relay-closed> sessionId=${sessionId} reason=${reason}`);
        serverLog('transport', `in-process transport closed by relay: sessionId=${sessionId} reason=${reason}`);
        this.onclose?.(reason);
      },
      isOpen: () => !this._closed,
    });
    this._handleMessage = handleMessage;
  }

  send(message: ProtocolRequest): void {
    if (this._closed || !this._handleMessage) {
      if (this._closed)
        debugLogger(`<in-process send-after-close> sessionId=${this._sessionId} method=${message.method}`);
      return;
    }
    this._handleMessage(message as unknown as CDPCommand).catch(e => {
      serverLog('warn', `in-process handleMessage error: sessionId=${this._sessionId} method=${message.method} error=${(e as Error).message}`);
    });
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    debugLogger(`<in-process closing> sessionId=${this._sessionId}`);
    serverLog('transport', `in-process transport closing: sessionId=${this._sessionId}`);
    this._relay.disconnectSession(this._sessionId);
    this._handleMessage = null;
    this.onclose?.();
  }
}
