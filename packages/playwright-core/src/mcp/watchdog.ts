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

import { gracefullyCloseAll, gracefullyCloseSet } from '../utils';
import { serverLog, testDebug } from './log';
import { getGlobalErrorLog } from '../tools/errorLog';

let isExiting = false;

async function handleExit(signal: string) {
  if (isExiting)
    return;
  isExiting = true;
  serverLog('signal', `received ${signal} — shutting down (${gracefullyCloseSet.size} resources to close)`);
  // eslint-disable-next-line no-restricted-properties
  setTimeout(() => {
    serverLog('signal', 'graceful shutdown timed out after 15s — forcing exit');
    process.exit(0);
  }, 15000);
  testDebug('gracefully closing ' + gracefullyCloseSet.size);
  await gracefullyCloseAll();
  serverLog('lifecycle', 'graceful shutdown complete');
  // eslint-disable-next-line no-restricted-properties
  process.exit(0);
}

/**
 * Arms stdin-EOF → graceful exit for stdio-mode MCP servers.
 *
 * When stdin is redirected to /dev/null (e.g., relay closes its pipe end),
 * Node fires 'end' but NOT 'close'. Without this, the HTTP server keeps
 * the event loop alive and the process hangs forever as a zombie.
 *
 * MUST only be called in stdio mode (port === undefined). In HTTP mode,
 * stdin EOF fires at startup (setsid + stdin from subshell) — the server
 * must NOT exit.
 */
export function enableStdinShutdown() {
  process.stdin.resume();  // ensure flowing mode so 'end' fires
  process.stdin.on('end', () => handleExit('stdin-eof'));
}

export function setupExitWatchdog() {
  process.stdin.on('close', () => handleExit('stdin-close'));
  process.on('SIGINT', () => handleExit('SIGINT'));
  process.on('SIGTERM', () => handleExit('SIGTERM'));
  process.on('SIGHUP', () => handleExit('SIGHUP'));

  process.on('uncaughtException', (error) => {
    serverLog('error', `uncaught exception: ${error.stack || error.message || error}`);
    getGlobalErrorLog()?.log('uncaught-exception', undefined, error);
    // eslint-disable-next-line no-restricted-properties
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    // Log but do not exit. Orphaned promises from timed-out tool dispatch
    // and browser_run_code detached promises are expected runtime events —
    // crashing the server kills all sessions for a single-promise failure.
    serverLog('rejection', `unhandled rejection (non-fatal): ${reason instanceof Error ? (reason.stack || reason.message) : String(reason)}`);
    getGlobalErrorLog()?.log('unhandled-rejection', undefined, reason);
  });

  process.on('exit', (code) => {
    serverLog('lifecycle', `process exiting with code ${code}`);
  });
}
