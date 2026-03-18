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

import fs from 'fs';
import path from 'path';

import { debug } from '../utilsBundle';

const perfDebug = debug('pw:mcp:perf');

export interface PerfEntry {
  ts: string;
  sid?: string;
  clientId?: string;
  tool?: string;
  callId?: string;
  phase: string;
  step: string;
  side: 'chrome' | 'server';
  target_ms: number;
  actual_ms: number;
  config_source?: string;
  [key: string]: any;
}

export class PerfLog {
  private _stream: fs.WriteStream | null = null;
  private _sessionId?: string;
  private _clientId?: string;
  private _toolName?: string;
  private _callId?: string;
  private _retentionDays: number;
  private _cleaned = false;

  constructor(private _logDir: string, retentionDays?: number) {
    this._retentionDays = retentionDays ?? 10;
  }

  setSession(sessionId: string) {
    this._sessionId = sessionId;
    this._write({
      ts: new Date().toISOString(),
      sid: sessionId,
      clientId: this._clientId,
      phase: 'session',
      step: 'init',
      side: 'server',
      target_ms: 0,
      actual_ms: 0,
    });
  }

  setClientId(clientId: string) { this._clientId = clientId; }
  setTool(toolName: string) { this._toolName = toolName; }
  setCallId(callId: string | undefined) { this._callId = callId; }

  async timeAsync<T>(
    entry: Omit<PerfEntry, 'ts' | 'actual_ms' | 'sid' | 'tool'>,
    fn: () => Promise<T>,
    extras?: (result: T | undefined, error?: unknown) => Record<string, any>,
  ): Promise<T> {
    const start = performance.now();
    let result: T | undefined;
    let extraFields: Record<string, any> = {};
    try {
      result = await fn();
      if (extras)
        extraFields = extras(result);
      return result;
    } catch (e) {
      if (extras)
        extraFields = extras(undefined, e);
      throw e;
    } finally {
      const actual_ms = Math.round(performance.now() - start);
      this._write({
        ...entry as PerfEntry,
        ...extraFields,
        actual_ms,
        ts: new Date().toISOString(),
        sid: this._sessionId,
        clientId: this._clientId,
        tool: this._toolName,
        callId: this._callId,
      });
    }
  }

  private _write(entry: PerfEntry) {
    perfDebug('%o', entry);
    this._ensureStream();
    this._stream?.write(JSON.stringify(entry) + '\n');
  }

  private _ensureStream() {
    if (this._stream)
      return;
    fs.mkdirSync(this._logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this._logDir, `perf-${date}.jsonl`);
    this._stream = fs.createWriteStream(filePath, { flags: 'a' });
    if (!this._cleaned) {
      this._cleaned = true;
      this._cleanOldFiles('perf-');
    }
  }

  private _cleanOldFiles(prefix: string) {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this._retentionDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      for (const file of fs.readdirSync(this._logDir)) {
        if (!file.startsWith(prefix) || !file.endsWith('.jsonl'))
          continue;
        const fileDate = file.replace(prefix, '').replace('.jsonl', '');
        if (fileDate < cutoffStr)
          fs.unlinkSync(path.join(this._logDir, file));
      }
    } catch (e) {
      perfDebug('cleanup error: %o', e);
    }
  }

  close() {
    this._stream?.end();
    this._stream = null;
  }
}

/** No-op PerfLog that never writes — used when perf logging is unavailable. */
class NullPerfLog extends PerfLog {
  constructor() { super(''); }
  override setSession(_sessionId: string) {}
  override setClientId(_clientId: string) {}
  override async timeAsync<T>(_entry: any, fn: () => Promise<T>, _extras?: any): Promise<T> {
    return fn();
  }
  override close() {}
}

export const nullPerfLog = new NullPerfLog();

export function createPerfLog(serviceDir: string, retentionDays?: number): PerfLog {
  return new PerfLog(path.join(serviceDir, '.local', 'perf'), retentionDays);
}
