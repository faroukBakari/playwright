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

const errorDebug = debug('pw:mcp:error');

export interface ErrorEntry {
  ts: string;
  sid?: string;
  tool: string;
  callId?: string;
  error: string;
  stack?: string;
}

export class ErrorLog {
  private _stream: fs.WriteStream | null = null;
  private _sessionId?: string;

  constructor(private _logDir: string) {}

  setSession(sessionId: string) { this._sessionId = sessionId; }

  log(tool: string, callId: string | undefined, error: unknown) {
    const entry: ErrorEntry = {
      ts: new Date().toISOString(),
      sid: this._sessionId,
      tool,
      callId,
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    errorDebug('%o', entry);
    this._ensureStream();
    this._stream?.write(JSON.stringify(entry) + '\n');
  }

  private _ensureStream() {
    if (this._stream)
      return;
    fs.mkdirSync(this._logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this._logDir, `errors-${date}.jsonl`);
    this._stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  close() {
    this._stream?.end();
    this._stream = null;
  }
}

export function createErrorLog(serviceDir: string): ErrorLog {
  return new ErrorLog(path.join(serviceDir, '.local', 'errors'));
}
