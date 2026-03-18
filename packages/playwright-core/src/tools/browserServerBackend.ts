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

import { Context } from './context';
import { Response, requestDebug } from './response';
import { SessionLog } from './sessionLog';
import { createPerfLog } from './perfLog';
import { createErrorLog } from './errorLog';
import { debug } from '../utilsBundle';
import { serverLog } from '../mcp/log';
import crypto from 'crypto';

import type { SnapshotMode } from './snapshotOptions';

import type { ContextConfig } from './context';
import type { PerfLog } from './perfLog';
import type { ErrorLog } from './errorLog';
import type * as playwright from '../../types/types';
import type { Tool } from './tool';
import type * as mcpServer from '../mcp/sdk/server';
import type { ClientInfo, ServerBackend } from '../mcp/sdk/server';

export class BrowserServerBackend implements ServerBackend {
  private _tools: Tool[];
  private _context: Context | undefined;
  private _sessionLog: SessionLog | undefined;
  private _perfLog: PerfLog | undefined;
  private _errorLog: ErrorLog | undefined;
  private _config: ContextConfig;
  private _serviceDir: string | undefined;
  readonly browserContext: playwright.BrowserContext;

  constructor(config: ContextConfig, browserContext: playwright.BrowserContext, tools: Tool[], serviceDir?: string) {
    this._config = config;
    this._tools = tools;
    this.browserContext = browserContext;
    this._serviceDir = serviceDir;
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._sessionLog = this._config.saveSession ? await SessionLog.create(this._config, clientInfo.cwd) : undefined;
    if (this._serviceDir) {
      const retentionDays = this._config.logging?.retentionDays;
      this._perfLog = createPerfLog(this._serviceDir, retentionDays);
      this._errorLog = createErrorLog(this._serviceDir, retentionDays);
    }
    if (clientInfo.sessionId) {
      this._perfLog?.setSession(clientInfo.sessionId);
      this._errorLog?.setSession(clientInfo.sessionId);
    }
    this._context = new Context(this.browserContext, {
      config: this._config,
      sessionLog: this._sessionLog,
      perfLog: this._perfLog,
      cwd: clientInfo.cwd,
    });
    this._perfLog?.setClientId(this._context.id);
  }

  async dispose() {
    this._perfLog?.close();
    this._errorLog?.close();
    await this._context?.dispose().catch(e => debug('pw:tools:error')(e));
  }

  static readonly DEFAULT_TIMEOUTS: Record<string, number> = {
    readOnly: 5000,
    input: 5000,
    action: 5000,
    assertion: 5000,
  };

  static readonly NAVIGATE_TOOLS = new Set([
    'browser_navigate', 'browser_navigate_and_wait',
    'browser_navigate_back', 'browser_navigate_forward', 'browser_reload',
  ]);

  private _resolveTimeout(name: string, toolType: string, timeoutSec: number | undefined): number {
    if (timeoutSec !== undefined)
      return timeoutSec * 1000;
    const cfg = this._config.toolTimeouts;
    if (BrowserServerBackend.NAVIGATE_TOOLS.has(name))
      return cfg?.navigate ?? 15000;
    if (name === 'browser_run_code')
      return cfg?.runCode ?? 30000;
    return cfg?.default ?? BrowserServerBackend.DEFAULT_TIMEOUTS[toolType] ?? 5000;
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments']) {
    const tool = this._tools.find(tool => tool.schema.name === name)!;
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `### Error\nTool "${name}" not found` }],
        isError: true,
      };
    }

    // Extract timeout for dispatch-level enforcement. Don't delete from rawArguments —
    // tools with their own timeout schema (wait, navigateAndWait) still receive it
    // via inputSchema.parse(). Tools without it in their schema get it stripped by zod.
    const timeoutSec = rawArguments?.timeout !== undefined
      ? Number(rawArguments.timeout) : undefined;
    const timeoutMs = this._resolveTimeout(name, tool.schema.type, timeoutSec);

    const parsedArguments = tool.schema.inputSchema.parse(rawArguments || {}) as any;
    const cwd = rawArguments?._meta && typeof rawArguments?._meta === 'object' && (rawArguments._meta as any)?.cwd;
    const snapshotMode: SnapshotMode | undefined = parsedArguments?.includeSnapshot;
    const snapshotSelector = parsedArguments?.snapshotSelector;
    if (snapshotMode !== undefined || snapshotSelector !== undefined)
      requestDebug('tool=%s includeSnapshot=%s snapshotSelector=%s', name, snapshotMode, snapshotSelector);
    const context = this._context!;
    const callId = crypto.randomUUID();
    context.perfLog.setTool(name);
    context.perfLog.setCallId(callId);
    const response = new Response(context, name, parsedArguments, cwd, snapshotSelector, snapshotMode);
    context.setRunningTool(name);
    let responseObject: mcpServer.CallToolResult;
    const toolStart = performance.now();
    try {
      responseObject = await context.perfLog.timeAsync(
        { phase: 'tool', step: 'e2e', side: 'server', target_ms: 0 },
        async () => {
          const toolPromise = tool.handle(context, parsedArguments, response);
          let timedOut = false;
          let timeoutId: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          });

          try {
            await Promise.race([toolPromise, timeoutPromise]);
          } catch (e) {
            clearTimeout(timeoutId!);
            if (timedOut) {
              // Timeout won — tool handler is still running in the browser.
              // Catch its eventual rejection so it doesn't become an unhandled
              // rejection at process level. Log with full dispatch context.
              toolPromise.catch(orphanedError => {
                serverLog('orphaned', `[${name}] callId=${callId}: ${orphanedError}`);
                this._errorLog?.log(name, callId, orphanedError);
              });
            }
            throw e;
          }
          clearTimeout(timeoutId!);
          return await response.serialize();
        },
        (result, error) => ({
          args_keys: Object.keys(parsedArguments),
          response_chars: result ? JSON.stringify(result).length : 0,
          timeout_ms: timeoutMs,
          outcome: error ? (String(error).includes('timed out') ? 'timeout' : 'error') : 'success',
        }),
      );
      this._sessionLog?.logResponse(name, parsedArguments, responseObject);
      const elapsed = Math.round(performance.now() - toolStart);
      if (elapsed > timeoutMs * 0.8)
        serverLog('warn', `[${name}] callId=${callId}: ${elapsed}ms / ${timeoutMs}ms (${Math.round(elapsed / timeoutMs * 100)}% of timeout)`);
    } catch (error: any) {
      this._errorLog?.log(name, callId, error);
      return {
        content: [{ type: 'text' as const, text: `### Error\n${String(error)}` }],
        isError: true,
      };
    } finally {
      context.setRunningTool(undefined);
      context.perfLog.setCallId(undefined);
    }
    return responseObject;
  }
}
