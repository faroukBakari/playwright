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
import type { ClientInfo, ProgressCallback, ServerBackend } from '../mcp/sdk/server';

export type BrowserFactory = (sessionId?: string) => Promise<playwright.BrowserContext>;

/**
 * Proxy that wraps a shared BrowserServerBackend, routing tool calls to the
 * correct session context via an explicit sessionId parameter. Used in
 * extension mode so multiple MCP sessions share ONE BrowserServerBackend
 * while each getting its own isolated browser context (tab).
 */
export class SharedBackendProxy implements ServerBackend {
  constructor(
    private _backend: BrowserServerBackend,
    private _sessionId: string,
  ) {
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    if (!this._backend.initialized)
      await this._backend.initialize(clientInfo);
  }

  async callTool(name: string, rawArguments: any, progress: ProgressCallback) {
    return this._backend.callTool(name, rawArguments, progress, this._sessionId);
  }

  async dispose(): Promise<void> {
    // No-op — shared backend lifecycle managed by the factory in program.ts.
  }

  async removeSessionContext(): Promise<void> {
    await this._backend.removeContext(this._sessionId);
  }
}

export class BrowserServerBackend implements ServerBackend {
  private _tools: Tool[];
  private _contexts: Map<string, Context> = new Map();
  private _defaultSessionId: string | undefined;
  private _sessionLog: SessionLog | undefined;
  private _perfLog: PerfLog | undefined;
  private _errorLog: ErrorLog | undefined;
  private _config: ContextConfig;
  private _serviceDir: string | undefined;
  private _browserFactory?: BrowserFactory;
  private _extraBrowsers: Map<string, playwright.Browser> = new Map();
  private _clientInfo: ClientInfo | undefined;
  private _initialized = false;
  readonly browserContext: playwright.BrowserContext | null;

  get initialized() { return this._initialized; }

  constructor(config: ContextConfig, browserContext: playwright.BrowserContext | null, tools: Tool[], serviceDir?: string, browserFactory?: BrowserFactory) {
    this._config = config;
    this._tools = tools;
    this.browserContext = browserContext;
    this._serviceDir = serviceDir;
    this._browserFactory = browserFactory;
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._initialized = true;
    this._clientInfo = clientInfo;
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
    // Create default context only when a browserContext was provided at
    // construction time (non-extension path). In extension mode, all contexts
    // are created lazily via _resolveContext → _browserFactory.
    if (this.browserContext) {
      const context = new Context(this.browserContext, {
        config: this._config,
        sessionLog: this._sessionLog,
        perfLog: this._perfLog,
        cwd: clientInfo.cwd,
      });
      this._defaultSessionId = context.id;
      this._contexts.set(context.id, context);
      this._perfLog?.setClientId(context.id);
    }
  }

  async dispose() {
    this._perfLog?.close();
    this._errorLog?.close();
    // Dispose all contexts (default + session-created)
    const disposals = [...this._contexts.values()].map(
        ctx => ctx.dispose().catch(e => {
          debug('pw:tools:error')(e);
          serverLog('warn', 'context disposal error', e);
        })
    );
    await Promise.all(disposals);
    this._contexts.clear();
    // Close extra browsers created by the factory
    for (const browser of this._extraBrowsers.values())
      await browser.close().catch(e => serverLog('warn', 'extra browser close error', e));
    this._extraBrowsers.clear();
  }

  /**
   * Remove a single session context and close its associated browser.
   * Called by SharedBackendProxy when an MCP session disconnects.
   */
  async removeContext(sessionId: string): Promise<void> {
    const ctx = this._contexts.get(sessionId);
    if (!ctx)
      return;
    await ctx.dispose().catch(e => {
      debug('pw:tools:error')(e);
      serverLog('warn', `context disposal error for sessionId="${sessionId}"`, e);
    });
    this._contexts.delete(sessionId);
    // Close the extra browser backing this context
    const extraBrowser = this._extraBrowsers.get(sessionId);
    if (extraBrowser) {
      this._extraBrowsers.delete(sessionId);
      await extraBrowser.close().catch(e => serverLog('warn', `extra browser close error for sessionId="${sessionId}"`, e));
    }
    serverLog('lifecycle', `removed context for sessionId="${sessionId}" (remaining: ${this._contexts.size})`);
  }

  static readonly NAVIGATE_TOOLS = new Set([
    'browser_navigate', 'browser_navigate_and_wait',
    'browser_navigate_back', 'browser_navigate_forward', 'browser_reload',
  ]);

  // Tab requirement is now derived from tool.noTabRequired (set in each tool definition).
  // Tools with noTabRequired: true can run without an active tab — all others fast-fail
  // with a descriptive error instead of timing out.

  private _resolveTimeout(tool: Tool, rawArguments: Record<string, unknown> | undefined, timeoutSec: number | undefined): number {
    // Tier budget: name-based dispatch (existing logic)
    const b = this._config.timeouts?.budget;
    const budget = { default: b?.default ?? 5000, navigate: b?.navigate ?? 15000, runCode: b?.runCode ?? 30000 };
    let tierBudget: number;
    if (BrowserServerBackend.NAVIGATE_TOOLS.has(tool.schema.name))
      tierBudget = budget.navigate;
    else if (tool.schema.name === 'browser_run_code')
      tierBudget = budget.runCode;
    else
      tierBudget = budget.default;

    // Computed floor: tool declares its minimum based on args
    const computedFloor = tool.schema.minBudget?.(rawArguments ?? {}) ?? 0;

    // Effective default: max of tier and computed floor
    const effectiveDefault = Math.max(tierBudget, computedFloor);

    // Per-call override: user can escalate above floor, but not below it
    if (timeoutSec !== undefined)
      return Math.max(timeoutSec * 1000, computedFloor);

    return effectiveDefault;
  }

  private async _resolveContext(sessionId?: string): Promise<Context> {
    // No ID → default context (full backward compat)
    if (!sessionId)
      return this._contexts.get(this._defaultSessionId!)!;

    // Known ID → return cached context
    const existing = this._contexts.get(sessionId);
    if (existing)
      return existing;

    // New ID without factory → fall back to default context
    if (!this._browserFactory) {
      serverLog('warn', `sessionId="${sessionId}" requested but no browser factory available, using default context`);
      return this._contexts.get(this._defaultSessionId!)!;
    }

    // New ID with factory → create isolated browser + context
    serverLog('lifecycle', `creating new browser context for sessionId="${sessionId}"`);
    const browserContext = await this._browserFactory(sessionId);
    const browser = browserContext.browser();
    if (browser)
      this._extraBrowsers.set(sessionId, browser);
    const context = new Context(browserContext, {
      config: this._config,
      sessionLog: this._sessionLog,
      perfLog: this._perfLog,
      cwd: this._clientInfo?.cwd || process.cwd(),
    });
    context.setClientId(sessionId);
    this._contexts.set(sessionId, context);
    this._perfLog?.setClientId(sessionId);
    return context;
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'], progress: ProgressCallback, sessionId?: string) {
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
    const timeoutMs = this._resolveTimeout(tool, rawArguments as Record<string, unknown> | undefined, timeoutSec);

    const parsedArguments = tool.schema.inputSchema.parse(rawArguments || {}) as any;
    const cwd = rawArguments?._meta && typeof rawArguments?._meta === 'object' && (rawArguments._meta as any)?.cwd;
    const snapshotMode: SnapshotMode | undefined = parsedArguments?.includeSnapshot;
    const snapshotSelector = parsedArguments?.snapshotSelector;
    if (snapshotMode !== undefined || snapshotSelector !== undefined)
      requestDebug('tool=%s includeSnapshot=%s snapshotSelector=%s', name, snapshotMode, snapshotSelector);
    const context = await this._resolveContext(sessionId);
    const callId = crypto.randomUUID();
    context.perfLog.setTool(name);
    context.perfLog.setCallId(callId);
    const response = new Response(context, name, parsedArguments, cwd, snapshotSelector, snapshotMode);
    context.setRunningTool(name);
    context.setDeadline(timeoutMs);
    const hasPage = !!context.currentTab();
    const pageUrl = hasPage ? context.currentTab()!.page.url() : undefined;
    serverLog('info', `[${name}] callId=${callId} session=${sessionId ?? 'default'} tabs=${context.tabs().length} currentTab=${hasPage ? pageUrl : 'none'} timeout=${timeoutMs}ms`);

    let responseObject: mcpServer.CallToolResult;
    const toolStart = performance.now();
    try {
      // Fast-fail when no tab exists and the tool requires one.
      // Inside the try so that finally{} handles setRunningTool cleanup.
      if (!hasPage && !tool.noTabRequired) {
        const msg = `No active tab — use browser_navigate or browser_create_tab to open a page first.`;
        serverLog('warn', `[${name}] fast-fail: ${msg}`);
        return {
          content: [{ type: 'text' as const, text: `### Error\n\n${msg}` }],
          isError: true,
        };
      }

      responseObject = await context.perfLog.timeAsync(
        { phase: 'tool', step: 'e2e', side: 'server', target_ms: timeoutMs },
        async () => {
          const toolPromise = tool.handle(context, parsedArguments, response);
          let timedOut = false;
          let timeoutId: ReturnType<typeof setTimeout>;
          const safetyNetMs = timeoutMs + 500;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              const stateHint = hasPage
                ? `active page: ${pageUrl}`
                : 'no active page — session may be stale or tab creation failed';
              serverLog('warn', `[${name}] Safety-net timeout fired after ${safetyNetMs}ms (inner deadline was ${timeoutMs}ms). Session state: ${stateHint}. Inner deadline propagation may have failed — check tool handler.`);
              const suggestion = hasPage
                ? ''
                : ' No active page in this session — try browser_create_tab or restart the server.';
              reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms.${suggestion}`));
            }, safetyNetMs);
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
      const elapsed = Math.round(performance.now() - toolStart);
      this._errorLog?.log(name, callId, error, { timeout_ms: timeoutMs, actual_ms: elapsed });
      return {
        content: [{ type: 'text' as const, text: `### Error\n${String(error)}` }],
        isError: true,
      };
    } finally {
      context.setRunningTool(undefined);
      context.clearDeadline();
      context.perfLog.setCallId(undefined);
    }
    return responseObject;
  }
}
