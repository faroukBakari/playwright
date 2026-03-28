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
 * Grace timer management and buffer state for the CDP relay.
 * Owns: state transitions, grace timers, and the grace buffer.
 * The coordinator owns client map mutations and extension lifecycle.
 * Callbacks bridge state-expiry events back to the coordinator.
 */

import { debug } from '../utilsBundle';
import { serverLog } from './log';
import type { RelayState } from './cdpRelayTypes';

const debugLogger = debug('pw:mcp:relay');

export const DEFAULT_GRACE_TTL = 5_000;
export const DEFAULT_EXTENSION_GRACE_TTL = 2_000;
export const DEFAULT_GRACE_BUFFER_MAX_BYTES = 2 * 1024 * 1024;

export interface StateMachineCallbacks {
  onServerGraceExpired(hasPerSessionGrace: boolean): void;
  onExtensionGraceExpired(): void;
}

export class CDPRelayStateMachine {
  private _state: RelayState = 'disconnected';
  private _graceTimer: ReturnType<typeof setTimeout> | null = null;
  private _graceBuffer: { data: string; size: number }[] = [];
  private _graceBufferBytes = 0;
  private readonly _graceTTL: number;
  private readonly _graceBufferMaxBytes: number;
  private _extensionGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _extensionGraceTTL: number;
  private readonly _callbacks: StateMachineCallbacks;
  private readonly _getPerSessionGraceCount: () => number;

  constructor(options: {
    graceTTL: number;
    extensionGraceTTL: number;
    graceBufferMaxBytes: number;
    callbacks: StateMachineCallbacks;
    getPerSessionGraceCount: () => number;
  }) {
    this._graceTTL = options.graceTTL;
    this._extensionGraceTTL = options.extensionGraceTTL;
    this._graceBufferMaxBytes = options.graceBufferMaxBytes;
    this._callbacks = options.callbacks;
    this._getPerSessionGraceCount = options.getPerSessionGraceCount;
  }

  get state(): RelayState { return this._state; }
  set state(s: RelayState) { this._state = s; }

  get graceBuffer(): { data: string; size: number }[] { return this._graceBuffer; }
  set graceBuffer(v: { data: string; size: number }[]) { this._graceBuffer = v; }

  get graceBufferBytes(): number { return this._graceBufferBytes; }
  set graceBufferBytes(v: number) { this._graceBufferBytes = v; }

  enterGrace(): void {
    debugLogger(`Entering grace period (${this._graceTTL}ms)`);
    this._state = 'grace';
    this._graceBuffer = [];
    this._graceBufferBytes = 0;
    this._graceTimer = setTimeout(() => {
      serverLog('critical', `Playwright grace expired after ${this._graceTTL}ms`);
      debugLogger('Grace period expired');
      this._graceTimer = null;
      this._state = 'disconnected';
      const hasPerSessionGrace = this._getPerSessionGraceCount() > 0;
      if (hasPerSessionGrace) {
        debugLogger(`Server grace expired but ${this._getPerSessionGraceCount()} per-session grace(s) active — keeping extension`);
        return;
      }
      this._callbacks.onServerGraceExpired(false);
    }, this._graceTTL);
  }

  cancelGrace(): void {
    if (this._graceTimer) {
      clearTimeout(this._graceTimer);
      this._graceTimer = null;
    }
  }

  flushGraceBuffer(sendFn: (data: string) => void): void {
    debugLogger(`Flushing ${this._graceBuffer.length} buffered events`);
    for (const event of this._graceBuffer)
      sendFn(event.data);
    this._graceBuffer = [];
    this._graceBufferBytes = 0;
  }

  enterExtensionGrace(): void {
    debugLogger(`Entering extension grace period (${this._extensionGraceTTL}ms)`);
    this._state = 'extensionGrace';
    this._extensionGraceTimer = setTimeout(() => {
      serverLog('critical', `Extension grace expired after ${this._extensionGraceTTL}ms`);
      debugLogger('Extension grace period expired');
      this._extensionGraceTimer = null;
      this._state = 'disconnected';
      this._callbacks.onExtensionGraceExpired();
    }, this._extensionGraceTTL);
  }

  cancelExtensionGrace(): void {
    if (this._extensionGraceTimer) {
      clearTimeout(this._extensionGraceTimer);
      this._extensionGraceTimer = null;
    }
  }

  bufferEvent(data: string): void {
    const size = data.length * 2;
    while (this._graceBufferBytes + size > this._graceBufferMaxBytes && this._graceBuffer.length > 0) {
      const evicted = this._graceBuffer.shift()!;
      this._graceBufferBytes -= evicted.size;
    }
    this._graceBuffer.push({ data, size });
    this._graceBufferBytes += size;
  }

  clearBuffer(): void {
    this._graceBuffer = [];
    this._graceBufferBytes = 0;
  }

  reset(): void {
    this.cancelGrace();
    this.cancelExtensionGrace();
    this._graceBuffer = [];
    this._graceBufferBytes = 0;
    this._state = 'disconnected';
  }
}
