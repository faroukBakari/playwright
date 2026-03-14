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

const errorDebug = debug('pw:mcp:error');

export function logUnhandledError(error: unknown) {
  errorDebug(error);
}

export const testDebug = debug('pw:mcp:test');

/**
 * Always-on server lifecycle logger. Writes timestamped lines to stderr
 * (which server.sh redirects to .local/server.log). Not gated behind
 * DEBUG env var — these are the production breadcrumbs for troubleshooting
 * server crashes, idle exits, and session lifecycle.
 */
export function serverLog(category: string, message: string, ...args: unknown[]) {
  const now = new Date();
  const ts = now.toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace(' ', 'T')
    + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const extra = args.length > 0
    ? ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    : '';
  process.stderr.write(`[${ts}] [${category}] ${message}${extra}\n`);
}
