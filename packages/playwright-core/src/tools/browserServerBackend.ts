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

import crypto from 'crypto';
import { Context } from './context';
import { Response, requestDebug } from './response';
import { SessionLog } from './sessionLog';
import { createPerfLog, nullPerfLog } from './perfLog';
import { createErrorLog } from './errorLog';
import { RequestDeadlineError, runInRequestScope, runOutsideRequestScope } from './requestScope';
import { recycleTab } from './tabUtils';
import { debug } from '../utilsBundle';
import { serverLog } from '../mcp/log';

import type { SnapshotMode } from './snapshotOptions';

import type { ContextConfig } from './context';
import type { PerfLog } from './perfLog';
import type { ErrorLog } from './errorLog';
import type { RequestScope } from './requestScope';
import type * as playwright from '../../types/types';
import type { Tool } from './tool';
import type * as mcpServer from '../mcp/sdk/server';
import type { ClientInfo, ProgressCallback, ServerBackend } from '../mcp/sdk/server';

export type BrowserFactory = (sessionId?: string) => Promise<playwright.BrowserContext>;

const MAX_TIMEOUT_SEC = 600;
const WATCHDOG_ALLOWANCE_MS = 500;

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

  get sessionId(): string {
    return this._sessionId;
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
  // Admission state lives with the in-process browser contexts it serializes; nothing outside the process can own it.
  private _pendingContexts: Map<string, Promise<Context>> = new Map();
  private _sessionTails: Map<string, Promise<void>> = new Map();
  private _runningTools: Map<string, string> = new Map();
  private _recycleFailures: Map<string, string> = new Map();
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

    // New ID with factory → one creation per session, shared by every call that arrives meanwhile.
    // The browser connection outlives the call that creates it, so it is created outside that call's scope.
    let pending = this._pendingContexts.get(sessionId);
    if (!pending) {
      pending = runOutsideRequestScope(() => this._createContext(sessionId)).finally(() => this._pendingContexts.delete(sessionId));
      this._pendingContexts.set(sessionId, pending);
    }
    return await pending;
  }

  private async _createContext(sessionId: string): Promise<Context> {
    serverLog('lifecycle', `creating new browser context for sessionId="${sessionId}"`);
    const browserContext = await this._browserFactory!(sessionId);
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
    return context;
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'], progress: ProgressCallback, sessionId?: string) {
    const tool = this._tools.find(tool => tool.schema.name === name)!;
    if (!tool)
      return errorResult(`Tool "${name}" not found`);

    // Extract timeout for dispatch-level enforcement. Don't delete from rawArguments —
    // tools with their own timeout schema (wait, navigateAndWait) still receive it
    // via inputSchema.parse(). Tools without it in their schema get it stripped by zod.
    const timeoutSec = rawArguments?.timeout !== undefined
      ? Number(rawArguments.timeout) : undefined;
    if (timeoutSec !== undefined && !(timeoutSec <= MAX_TIMEOUT_SEC))
      return errorResult(`timeout is in seconds and cannot exceed ${MAX_TIMEOUT_SEC} (received ${String(rawArguments!.timeout)}).`);
    const timeoutMs = this._resolveTimeout(tool, rawArguments as Record<string, unknown> | undefined, timeoutSec);

    const parsedArguments = tool.schema.inputSchema.parse(rawArguments || {}) as any;
    const cwd = rawArguments?._meta && typeof rawArguments?._meta === 'object' && (rawArguments._meta as any)?.cwd;
    const snapshotMode: SnapshotMode | undefined = parsedArguments?.includeSnapshot;
    const snapshotSelector = parsedArguments?.snapshotSelector;
    if (snapshotMode !== undefined || snapshotSelector !== undefined)
      requestDebug('tool=%s includeSnapshot=%s snapshotSelector=%s', name, snapshotMode, snapshotSelector);
    const call: ToolCall = { tool, parsedArguments, cwd, snapshotSelector, snapshotMode, timeoutMs, sessionId };
    const scope: RequestScope = { callId: crypto.randomUUID(), tool: name, sessionId, deadline: Date.now() + timeoutMs };
    return await runInRequestScope(scope, () => this._admit(call, scope));
  }

  private async _admit(call: ToolCall, scope: RequestScope): Promise<mcpServer.CallToolResult> {
    const key = call.sessionId ?? '';
    const previous = this._sessionTails.get(key) ?? Promise.resolve();
    let releaseSlot!: () => void;
    const held = new Promise<void>(resolve => { releaseSlot = resolve; });
    const tail = previous.then(() => held);
    this._sessionTails.set(key, tail);
    void tail.then(() => {
      if (this._sessionTails.get(key) === tail)
        this._sessionTails.delete(key);
    });

    let deadlineTimer: ReturnType<typeof setTimeout>;
    const admitted = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>(resolve => {
        deadlineTimer = setTimeout(() => resolve(false), Math.max(0, scope.deadline - Date.now()));
      }),
    ]);
    clearTimeout(deadlineTimer!);
    if (!admitted) {
      releaseSlot();
      const running = this._runningTools.get(key) ?? 'an earlier call';
      serverLog('warn', `[${scope.tool}] callId=${scope.callId} session=${call.sessionId ?? 'default'} gave up its place: "${running}" still running after ${call.timeoutMs}ms`);
      return errorResult(`Session busy: "${running}" is still running. This call waited ${call.timeoutMs}ms for it and was not started.`);
    }

    this._runningTools.set(key, scope.tool);
    const release = () => {
      this._runningTools.delete(key);
      releaseSlot();
    };
    let stopping: Promise<void> | undefined;
    try {
      const outcome = await this._runAdmitted(call, scope);
      if (outcome.kind === 'timeout' && outcome.stop)
        stopping = runOutsideRequestScope(() => this._hardStop(key, outcome.stop!, scope));
      return outcome.result;
    } finally {
      // The result goes back now; after a hard stop the next call waits for the page to be re-attached.
      if (stopping)
        void stopping.then(release);
      else
        release();
    }
  }

  private async _hardStop(key: string, context: Context, scope: RequestScope): Promise<void> {
    try {
      await recycleTab(context, `hardStop(${scope.tool}, callId=${scope.callId})`);
      this._recycleFailures.delete(key);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      serverLog('warn', `[${scope.tool}] callId=${scope.callId} hard stop failed: ${reason}`);
      this._recycleFailures.set(key, reason);
    }
  }

  private async _runAdmitted(call: ToolCall, scope: RequestScope): Promise<CallOutcome> {
    const { tool, timeoutMs, parsedArguments } = call;
    const name = tool.schema.name;
    const toolStart = performance.now();
    const outcome = await (this._perfLog ?? nullPerfLog).timeAsync(
        { phase: 'tool', step: 'e2e', side: 'server', target_ms: timeoutMs },
        () => this._raceWatchdog(call, scope),
        settled => ({
          args_keys: Object.keys(parsedArguments),
          response_chars: settled?.kind === 'success' ? JSON.stringify(settled.result).length : 0,
          timeout_ms: timeoutMs,
          outcome: settled?.kind ?? 'error',
        }),
    );
    const elapsed = Math.round(performance.now() - toolStart);
    if (outcome.kind === 'success') {
      this._sessionLog?.logResponse(name, parsedArguments, outcome.result);
      if (elapsed > timeoutMs * 0.8)
        serverLog('warn', `[${name}] callId=${scope.callId}: ${elapsed}ms / ${timeoutMs}ms (${Math.round(elapsed / timeoutMs * 100)}% of timeout)`);
    } else {
      this._errorLog?.log(name, scope.callId, outcome.error, { timeout_ms: timeoutMs, actual_ms: elapsed });
    }
    return outcome;
  }

  private async _raceWatchdog(call: ToolCall, scope: RequestScope): Promise<CallOutcome> {
    const name = call.tool.schema.name;
    const progress: CallProgress = { stage: 'context', hadTab: false };
    const work = this._runTool(call, scope, progress);
    let watchdogTimer: ReturnType<typeof setTimeout>;
    const watchdog = new Promise<'expired'>(resolve => {
      watchdogTimer = setTimeout(() => resolve('expired'), Math.max(0, scope.deadline + WATCHDOG_ALLOWANCE_MS - Date.now()));
    });
    const settled = await Promise.race([
      work.then(result => ({ result }), (error: unknown) => ({ error })),
      watchdog,
    ]);
    clearTimeout(watchdogTimer!);

    if (settled === 'expired') {
      serverLog('warn', `[${name}] callId=${scope.callId} not finished ${WATCHDOG_ALLOWANCE_MS}ms after its ${call.timeoutMs}ms deadline, stage=${progress.stage}, tab=${progress.hadTab ? 'yes' : 'none'}`);
      work.catch(leftoverError => {
        serverLog('orphaned', `[${name}] callId=${scope.callId}: ${leftoverError}`);
        this._errorLog?.log(name, scope.callId, leftoverError);
      });
      const handlerPending = progress.stage !== 'response';
      const stop = handlerPending && progress.hadTab && progress.context?.relayHttpUrl ? progress.context : undefined;
      return { ...deadlineOutcome(call, progress), stop };
    }
    if ('error' in settled) {
      if (settled.error instanceof RequestDeadlineError)
        return deadlineOutcome(call, progress);
      return { kind: 'error', error: settled.error, result: errorResult(String(settled.error)) };
    }
    return { kind: 'success', result: settled.result };
  }

  private async _runTool(call: ToolCall, scope: RequestScope, progress: CallProgress): Promise<mcpServer.CallToolResult> {
    const { tool, parsedArguments, timeoutMs, sessionId } = call;
    const name = tool.schema.name;
    const context = await this._resolveContext(sessionId);
    const response = new Response(context, name, parsedArguments, call.cwd, call.snapshotSelector, call.snapshotMode);
    const tab = context.currentTab();
    progress.hadTab = !!tab;
    progress.context = context;
    serverLog('info', `[${name}] callId=${scope.callId} session=${sessionId ?? 'default'} tabs=${context.tabs().length} currentTab=${tab ? tab.page.url() : 'none'} timeout=${timeoutMs}ms`);

    const key = sessionId ?? '';
    if (tab)
      this._recycleFailures.delete(key);
    if (!tab && !tool.noTabRequired) {
      const recycleFailure = this._recycleFailures.get(key);
      this._recycleFailures.delete(key);
      const msg = `No active tab — attach to an existing tab or use browser_navigate / browser_create_tab to open a page first.`
        + (recycleFailure ? ` The previous call was stopped at its deadline and its page could not be re-attached: ${recycleFailure}` : '');
      serverLog('warn', `[${name}] fast-fail: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: `### Error\n\n${msg}` }],
        isError: true,
      };
    }

    progress.stage = 'handler';
    await tool.handle(context, parsedArguments, response);
    progress.stage = 'response';
    return await response.serialize();
  }
}

type ToolCall = {
  tool: Tool;
  parsedArguments: any;
  cwd: string | undefined;
  snapshotSelector: string | undefined;
  snapshotMode: SnapshotMode | undefined;
  timeoutMs: number;
  sessionId: string | undefined;
};

type CallProgress = {
  stage: 'context' | 'handler' | 'response';
  hadTab: boolean;
  context?: Context;
};

type CallOutcome =
  | { kind: 'success'; result: mcpServer.CallToolResult }
  | { kind: 'error'; error: unknown; result: mcpServer.CallToolResult }
  | { kind: 'timeout'; error: unknown; result: mcpServer.CallToolResult; stop?: Context };

function errorResult(message: string): mcpServer.CallToolResult {
  return {
    content: [{ type: 'text' as const, text: `### Error\n${message}` }],
    isError: true,
  };
}

function deadlineOutcome(call: ToolCall, progress: CallProgress): CallOutcome & { kind: 'timeout' } {
  const name = call.tool.schema.name;
  const error = new Error(progress.stage === 'response'
    ? `Tool "${name}" completed its action, but its response could not be built within ${call.timeoutMs}ms. Take a new snapshot before relying on the page state.`
    : `Tool "${name}" timed out after ${call.timeoutMs}ms. The call was stopped and the page is being re-attached; page JavaScript that already started may still take effect; element refs from earlier snapshots are invalid.`);
  return { kind: 'timeout', error, result: errorResult(String(error)) };
}
