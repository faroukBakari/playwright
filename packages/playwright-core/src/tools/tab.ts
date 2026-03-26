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

import url from 'url';

import { EventEmitter } from 'events';
import { asLocator } from '../utils/isomorphic/locatorGenerators';
import { ManualPromise } from '../utils/isomorphic/manualPromise';
import { debug } from '../utilsBundle';

import { eventsHelper } from '../client/eventEmitter';
import { callOnPageNoTrace, waitForCompletion, eventWaiter } from './utils';
import { LogFile } from './logFile';
import { ModalState } from './tool';
import { handleDialog } from './dialogs';
import { uploadFile } from './files';
import { disposeAll } from '../client/disposable';

import type { Disposable } from '../client/disposable';
import type { Context, ContextConfig } from './context';
import type { Page } from '../client/page';
import type { Locator } from '../client/locator';
import type * as playwright from '../../types/types';

const debugRefRecovery = debug('pw:mcp:ref-recovery');

const TabEvents = {
  modalState: 'modalState'
};

type TabEventsInterface = {
  [TabEvents.modalState]: [modalState: ModalState];
};

type Download = {
  download: playwright.Download;
  finished: boolean;
  outputFile: string;
};

type ConsoleLogEntry = {
  type: 'console';
  wallTime: number;
  message: ConsoleMessage;
};

type DownloadStartLogEntry = {
  type: 'download-start';
  wallTime: number;
  download: Download;
};

type DownloadFinishLogEntry = {
  type: 'download-finish';
  wallTime: number;
  download: Download;
};

type RequestLogEntry = {
  type: 'request';
  wallTime: number;
  request: playwright.Request;
};

type EventEntry = ConsoleLogEntry | DownloadStartLogEntry | DownloadFinishLogEntry | RequestLogEntry;


export type TabHeader = {
  title: string;
  url: string;
  current: boolean;
  console: { total: number, warnings: number, errors: number };
};

type TabSnapshot = {
  ariaSnapshot: string;
  ariaSnapshotDiff?: string;
  modalStates: ModalState[];
  events: EventEntry[];
  consoleLink?: string;
};

export class Tab extends EventEmitter<TabEventsInterface> {
  readonly context: Context;
  readonly page: Page;
  private _lastHeader: TabHeader = { title: 'about:blank', url: 'about:blank', current: false, console: { total: 0, warnings: 0, errors: 0 } };
  private _downloads: Download[] = [];
  private _requests: playwright.Request[] = [];
  private _onPageClose: (tab: Tab) => void;
  private _modalStates: ModalState[] = [];
  private _initializedPromise: Promise<void>;
  private _needsFullSnapshot = false;
  private _recentEventEntries: EventEntry[] = [];
  private _consoleLog: LogFile;
  private _disposables: Disposable[];
  private _actionTimeoutCeiling: number | undefined;
  private _navigationTimeoutCeiling: number | undefined;
  private _expectTimeoutCeiling: number | undefined;
  private _refMetadata = new Map<string, { role: string, name: string }>();

  constructor(context: Context, page: playwright.Page, onPageClose: (tab: Tab) => void) {
    super();
    this.context = context;
    this.page = page as Page;
    this._onPageClose = onPageClose;
    const p = page as Page;
    this._disposables = [
      eventsHelper.addEventListener(p, 'console', event => this._handleConsoleMessage(messageToConsoleMessage(event))),
      eventsHelper.addEventListener(p, 'pageerror', error => this._handleConsoleMessage(pageErrorToConsoleMessage(error))),
      eventsHelper.addEventListener(p, 'request', request => this._handleRequest(request)),
      eventsHelper.addEventListener(p, 'response', response => this._handleResponse(response)),
      eventsHelper.addEventListener(p, 'requestfailed', request => this._handleRequestFailed(request)),
      eventsHelper.addEventListener(p, 'close', () => this._onClose()),
      eventsHelper.addEventListener(p, 'filechooser', chooser => {
        this.setModalState({
          type: 'fileChooser',
          description: 'File chooser',
          fileChooser: chooser,
          clearedBy: { tool: uploadFile.schema.name, skill: 'upload' }
        });
      }),
      eventsHelper.addEventListener(p, 'dialog', dialog => this._dialogShown(dialog)),
      eventsHelper.addEventListener(p, 'download', download => {
        void this._downloadStarted(download);
      }),
    ];
    (page as any)[tabSymbol] = this;
    const wallTime = Date.now();
    this._consoleLog = new LogFile(this.context, wallTime, 'console', 'Console');
    this._initializedPromise = this._initialize();
    this._actionTimeoutCeiling = context.config.timeouts?.action;
    this._navigationTimeoutCeiling = context.config.timeouts?.navigation;
    this._expectTimeoutCeiling = context.config.timeouts?.expect;
  }

  async dispose() {
    await disposeAll(this._disposables);
    this._consoleLog.stop();
  }

  get actionTimeoutOptions(): { timeout?: number } {
    return { timeout: this._minTimeout(this._actionTimeoutCeiling) };
  }

  get navigationTimeoutOptions(): { timeout?: number } {
    return { timeout: this._minTimeout(this._navigationTimeoutCeiling) };
  }

  get expectTimeoutOptions(): { timeout?: number } {
    return { timeout: this._minTimeout(this._expectTimeoutCeiling) };
  }

  private _minTimeout(ceiling: number | undefined): number | undefined {
    const remaining = this.context.remainingBudget();
    if (ceiling === undefined && remaining === Infinity)
      return undefined;
    if (ceiling === undefined)
      return remaining;
    if (remaining === Infinity)
      return ceiling;
    return Math.min(ceiling, remaining);
  }

  static forPage(page: playwright.Page): Tab | undefined {
    return (page as any)[tabSymbol];
  }

  static async collectConsoleMessages(page: playwright.Page): Promise<ConsoleMessage[]> {
    const result: ConsoleMessage[] = [];
    const messages = await page.consoleMessages().catch(() => []);
    for (const message of messages)
      result.push(messageToConsoleMessage(message));
    const errors = await page.pageErrors().catch(() => []);
    for (const error of errors)
      result.push(pageErrorToConsoleMessage(error));
    return result;
  }

  private async _initialize() {
    for (const message of await Tab.collectConsoleMessages(this.page))
      this._handleConsoleMessage(message);
    const requests = await this.page.requests().catch(() => []);
    for (const request of requests.filter(r => r.existingResponse() || r.failure()))
      this._requests.push(request);
    for (const initPage of this.context.config.browser?.initPage || []) {
      try {
        const { default: func } = await import(url.pathToFileURL(initPage).href);
        await func({ page: this.page });
      } catch (e) {
        debug('pw:tools:error')(e);
      }
    }
  }

  modalStates(): ModalState[] {
    return this._modalStates;
  }

  setModalState(modalState: ModalState) {
    this._modalStates.push(modalState);
    this.emit(TabEvents.modalState, modalState);
  }

  clearModalState(modalState: ModalState) {
    this._modalStates = this._modalStates.filter(state => state !== modalState);
  }

  private _dialogShown(dialog: playwright.Dialog) {
    this.setModalState({
      type: 'dialog',
      description: `"${dialog.type()}" dialog with message "${dialog.message()}"`,
      dialog,
      clearedBy: { tool: handleDialog.schema.name, skill: 'dialog-accept or dialog-dismiss' }
    });
  }

  private async _downloadStarted(download: playwright.Download) {
    // Do not trust web names.
    const outputFile = await this.context.outputFile({ suggestedFilename: sanitizeForFilePath(download.suggestedFilename()), prefix: 'download', ext: 'bin' }, { origin: 'code' });
    const entry = {
      download,
      finished: false,
      outputFile,
    };
    this._downloads.push(entry);
    this._addLogEntry({ type: 'download-start', wallTime: Date.now(), download: entry });
    await download.saveAs(entry.outputFile);
    entry.finished = true;
    this._addLogEntry({ type: 'download-finish', wallTime: Date.now(), download: entry });
  }

  private _clearCollectedArtifacts() {
    this._downloads.length = 0;
    this._requests.length = 0;
    this._recentEventEntries.length = 0;
    this._resetLogs();
  }

  private _resetLogs() {
    const wallTime = Date.now();
    this._consoleLog.stop();
    this._consoleLog = new LogFile(this.context, wallTime, 'console', 'Console');
  }

  private _handleRequest(request: playwright.Request) {
    this._requests.push(request);
    // TODO: request start time is not available for fetch() before the
    // response is received, so we use Date.now() as a fallback.
    const wallTime = request.timing().startTime || Date.now();
    this._addLogEntry({ type: 'request', wallTime, request });
  }

  private _handleResponse(response: playwright.Response) {
    const timing = response.request().timing();
    const wallTime = timing.responseStart + timing.startTime;
    this._addLogEntry({ type: 'request', wallTime, request: response.request() });
  }

  private _handleRequestFailed(request: playwright.Request) {
    this._requests.push(request);
    const timing = request.timing();
    const wallTime = timing.responseEnd + timing.startTime;
    this._addLogEntry({ type: 'request', wallTime, request });
  }

  private _handleConsoleMessage(message: ConsoleMessage) {
    const wallTime = message.timestamp;
    this._addLogEntry({ type: 'console', wallTime, message });
    const level = consoleLevelForMessageType(message.type);
    if (level === 'error' || level === 'warning') {
      // Apply excludePatterns to console log file only — extension noise doesn't belong in error logs.
      // Events section filtering happens at emission in response.ts (supports per-call overrides).
      const excludePatterns = this.context.config.console?.excludePatterns;
      const excluded = excludePatterns?.length && message.location.url &&
        excludePatterns.some(pattern => message.location.url.startsWith(pattern));
      if (!excluded)
        this._consoleLog.appendLine(wallTime, () => message.toString());
    }
  }

  private _addLogEntry(entry: EventEntry) {
    this._recentEventEntries.push(entry);
  }

  private _onClose() {
    this._clearCollectedArtifacts();
    this._onPageClose(this);
  }

  async headerSnapshot(): Promise<TabHeader & { changed: boolean }> {
    let title: string | undefined;
    await this._raceAgainstModalStates(async () => {
      title = await callOnPageNoTrace(this.page, page => page.title());
    });
    const newHeader: TabHeader = {
      title: title ?? '',
      url: this.page.url(),
      current: this.isCurrentTab(),
      console: await this.consoleMessageCount()
    };

    if (!tabHeaderEquals(this._lastHeader, newHeader)) {
      this._lastHeader = newHeader;
      return { ...this._lastHeader, changed: true };
    }
    return { ...this._lastHeader, changed: false };
  }

  isCurrentTab(): boolean {
    return this === this.context.currentTab();
  }

  async waitForLoadState(state: 'load' | 'domcontentloaded', options?: { timeout?: number }): Promise<void> {
    await this._initializedPromise;
    await callOnPageNoTrace(this.page, page => page.waitForLoadState(state, options).catch(e => debug('pw:tools:error')(e)));
  }

  async navigate(url: string) {
    await this._initializedPromise;

    await this.clearConsoleMessages();
    this._clearCollectedArtifacts();

    const { promise: downloadEvent, abort: abortDownloadEvent } = eventWaiter<playwright.Download>(this.page, 'download', 3000);
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', ...this.navigationTimeoutOptions });
      abortDownloadEvent();
    } catch (_e: unknown) {
      const e = _e as Error;
      const mightBeDownload =
        e.message.includes('net::ERR_ABORTED') // chromium
        || e.message.includes('Download is starting'); // firefox + webkit
      if (!mightBeDownload)
        throw e;
      // on chromium, the download event is fired *after* page.goto rejects, so we wait a lil bit
      const download = await downloadEvent;
      if (!download)
        throw e;
      // Make sure other "download" listeners are notified first.
      await new Promise(resolve => setTimeout(resolve, 500));
      return;
    }

    // Cap load event — only useful when postNavState differs from goto's waitUntil
    const postNavState = this.context.config.performance?.postNavigateLoadState ?? 'domcontentloaded';
    if (postNavState !== 'domcontentloaded') {
      const postNavTimeout = this.context.config.performance?.postNavigateLoadTimeout ?? 3000;
      await this.context.perfLog.timeAsync({
        phase: 'navigate', step: 'postNavigateLoad', side: 'chrome',
        target_ms: postNavTimeout, state: postNavState,
      }, () => this.waitForLoadState(postNavState, { timeout: postNavTimeout }));
    }
  }

  async consoleMessageCount(): Promise<{ total: number, errors: number, warnings: number }> {
    await this._initializedPromise;
    const messages = await this.page.consoleMessages();
    const pageErrors = await this.page.pageErrors();
    let errors = pageErrors.length;
    let warnings = 0;
    for (const message of messages) {
      if (message.type() === 'error')
        errors++;
      else if (message.type() === 'warning')
        warnings++;
    }
    return { total: messages.length + pageErrors.length, errors, warnings };
  }

  async consoleMessages(level: ConsoleMessageLevel, excludePatterns?: string[]): Promise<ConsoleMessage[]> {
    await this._initializedPromise;
    const result: ConsoleMessage[] = [];
    const messages = await this.page.consoleMessages();
    for (const message of messages) {
      const cm = messageToConsoleMessage(message);
      if (excludePatterns?.length && cm.location.url &&
          excludePatterns.some(p => cm.location.url.startsWith(p)))
        continue;
      if (shouldIncludeMessage(level, cm.type))
        result.push(cm);
    }
    if (shouldIncludeMessage(level, 'error')) {
      const errors = await this.page.pageErrors();
      for (const error of errors)
        result.push(pageErrorToConsoleMessage(error));
    }
    return result;
  }

  async clearConsoleMessages() {
    await this._initializedPromise;
    await Promise.all([
      this.page.clearConsoleMessages(),
      this.page.clearPageErrors()
    ]);
  }

  async requests(): Promise<playwright.Request[]> {
    await this._initializedPromise;
    return this._requests;
  }

  async clearRequests() {
    await this._initializedPromise;
    this._requests.length = 0;
  }

  async captureSnapshot(relativeTo: string | undefined, options?: { rootSelector?: string; clientId?: string }): Promise<TabSnapshot> {
    await this._initializedPromise;
    const interactableOnly = this.context.config.snapshot?.interactableOnly;
    const settleMode = this.context.config.snapshot?.settleMode ?? 'quick';
    const gatesEnabled = this.context.config.snapshot?.gatesEnabled ?? true;
    const gateTimeoutMs = this.context.config.snapshot?.gateTimeoutMs ?? 2000;
    const rootSelector = options?.rootSelector;
    let tabSnapshot: TabSnapshot | undefined;
    const modalStates = await this._raceAgainstModalStates(async () => {
      // Settle before snapshot: wait for framework re-renders to complete
      if (settleMode !== 'none') {
        const quietMs = this.context.config.snapshot?.settleQuietMs ?? 150;
        const settleResult = await this.page.evaluate(async ({ mode, quietMs, rootSelector, gatesEnabled, gateTimeoutMs }) => {
          const t0 = performance.now();
          const gateResults: Record<string, string> = { nav: 'skip', vt: 'skip', ariaBusy: 'skip' };

          if (gatesEnabled) {
            // Gate 1: Navigation API transition
            if (typeof (globalThis as any).navigation !== 'undefined' && (globalThis as any).navigation.transition) {
              gateResults.nav = 'active';
              await Promise.race([
                (globalThis as any).navigation.transition.finished.then(() => 'finished'),
                new Promise(r => setTimeout(() => r('timeout'), gateTimeoutMs)),
              ]);
              gateResults.nav = 'cleared';
            } else {
              gateResults.nav = 'inactive';
            }

            // Gate 2: View Transitions API
            try {
              if (document.documentElement.matches?.(':active-view-transition')) {
                gateResults.vt = 'active';
                await Promise.race([
                  new Promise<void>(resolve => {
                    const check = () => {
                      if (!document.documentElement.matches(':active-view-transition'))
                        return resolve();
                      requestAnimationFrame(check);
                    };
                    requestAnimationFrame(check);
                  }),
                  new Promise(r => setTimeout(() => r('timeout'), gateTimeoutMs)),
                ]);
                gateResults.vt = 'cleared';
              } else {
                gateResults.vt = 'inactive';
              }
            } catch {
              // :active-view-transition not supported in this browser
              gateResults.vt = 'unsupported';
            }

            // Gate 3: aria-busy
            if (document.querySelector('[aria-busy="true"]')) {
              gateResults.ariaBusy = 'active';
              await Promise.race([
                new Promise<void>(resolve => {
                  const mo = new MutationObserver(() => {
                    if (!document.querySelector('[aria-busy="true"]')) {
                      mo.disconnect(); resolve();
                    }
                  });
                  mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['aria-busy'] });
                }),
                new Promise(r => setTimeout(() => r('timeout'), gateTimeoutMs)),
              ]);
              gateResults.ariaBusy = 'cleared';
            } else {
              gateResults.ariaBusy = 'inactive';
            }
          }

          const gateMs = performance.now() - t0;

          // T1: drain microtask queue + double rAF
          await Promise.resolve();
          await new Promise<void>(r =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          );

          // T2: filtered MutationObserver quiescence
          if (mode === 'thorough') {
            const root = rootSelector
              ? document.querySelector(rootSelector) ?? document.body
              : document.body;
            await new Promise<void>(resolve => {
              let quietTimer: ReturnType<typeof setTimeout>;
              const maxTimer = setTimeout(() => {
                observer.disconnect(); resolve();
              }, Math.max(quietMs * 4, 1000));
              const observer = new MutationObserver(mutations => {
                const meaningful = mutations.some(m => {
                  if (m.type === 'childList') {
                    for (const node of m.addedNodes) {
                      if (node.nodeType === 1) {
                        const tag = (node as Element).tagName;
                        if (tag !== 'SCRIPT' && tag !== 'STYLE'
                            && tag !== 'LINK' && tag !== 'IMG')
                          return true;
                      }
                    }
                    return m.removedNodes.length > 0;
                  }
                  if (m.type === 'attributes')
                    return !m.attributeName?.startsWith('data-analytics')
                        && !m.attributeName?.startsWith('data-track');
                  return true;
                });
                if (!meaningful) return;
                clearTimeout(quietTimer);
                quietTimer = setTimeout(() => {
                  observer.disconnect(); clearTimeout(maxTimer); resolve();
                }, quietMs);
              });
              observer.observe(root, {
                childList: true, subtree: true,
                attributes: true, characterData: true,
              });
              quietTimer = setTimeout(() => {
                observer.disconnect(); clearTimeout(maxTimer); resolve();
              }, quietMs);
            });
          }

          const settleMs = performance.now() - t0;
          return { gateMs, settleMs, gateResults };
        }, { mode: settleMode, quietMs, rootSelector, gatesEnabled, gateTimeoutMs });

        // Log gate telemetry server-side
        if (gatesEnabled && settleResult) {
          this.context.perfLog.timeAsync({
            phase: 'snapshot', step: 'settle-gates',
            side: 'chrome',
            target_ms: gateTimeoutMs,
            gate_nav: settleResult.gateResults.nav,
            gate_vt: settleResult.gateResults.vt,
            gate_aria_busy: settleResult.gateResults.ariaBusy,
            gate_ms: settleResult.gateMs,
            settle_ms: settleResult.settleMs,
            settle_mode: settleMode,
          }, async () => {});
        }
      }

      const snapshot = await this.context.perfLog.timeAsync({
        phase: 'snapshot', step: 'capture', side: 'chrome',
        target_ms: 8000,
        interactableOnly: !!interactableOnly,
        rootSelector: rootSelector || undefined,
      }, () => this.page._snapshotForAI({ track: `response-${options?.clientId ?? this.context.id}`, interactableOnly, rootSelector }), (result) => ({
        full_chars: result?.full.length ?? 0,
        diff_chars: result?.incremental?.length,
      }));
      tabSnapshot = {
        ariaSnapshot: snapshot.full,
        ariaSnapshotDiff: this._needsFullSnapshot ? undefined : snapshot.incremental,
        modalStates: [],
        events: [],
      };
      this._parseRefMetadata(snapshot.full);
    });
    if (tabSnapshot) {
      tabSnapshot.consoleLink = await this._consoleLog.take(relativeTo);
      tabSnapshot.events = this._recentEventEntries;
      this._recentEventEntries = [];
    }

    // If we failed to capture a snapshot this time, make sure we do a full one next time,
    // to avoid reporting deltas against un-reported snapshot.
    this._needsFullSnapshot = !tabSnapshot;
    return tabSnapshot ?? {
      ariaSnapshot: '',
      ariaSnapshotDiff: '',
      modalStates,
      events: [],
    };
  }

  private _javaScriptBlocked(): boolean {
    return this._modalStates.some(state => state.type === 'dialog');
  }

  private async _raceAgainstModalStates(action: () => Promise<void>): Promise<ModalState[]> {
    if (this.modalStates().length)
      return this.modalStates();

    const promise = new ManualPromise<ModalState[]>();
    const listener = (modalState: ModalState) => promise.resolve([modalState]);
    this.once(TabEvents.modalState, listener);

    return await Promise.race([
      action().then(() => {
        this.off(TabEvents.modalState, listener);
        return [];
      }),
      promise,
    ]);
  }

  async waitForCompletion(callback: () => Promise<void>) {
    await this._initializedPromise;
    await this._raceAgainstModalStates(() => waitForCompletion(this, callback));
  }

  async refLocator(params: { element?: string, ref: string }): Promise<{ locator: Locator, resolved: string }> {
    await this._initializedPromise;
    try {
      return (await this.refLocators([params]))[0];
    } catch (firstError) {
      // Save stale ref metadata before re-snapshot clears it
      const staleRefMeta = this._refMetadata.get(params.ref);
      // Re-snapshot to refresh the element map (no event side effects)
      debugRefRecovery('stale ref=%s — re-snapshotting (meta: role=%s name=%s)', params.ref, staleRefMeta?.role, staleRefMeta?.name?.slice(0, 50));
      const interactableOnly = this.context.config.snapshot?.interactableOnly;
      const snapshot = await this.page._snapshotForAI({
        track: `response-${this.context.id}`,
        interactableOnly,
      });
      this._parseRefMetadata(snapshot.full);
      // Restore stale ref metadata for fallback (re-snapshot won't contain it)
      if (staleRefMeta)
        this._refMetadata.set(params.ref, staleRefMeta);
      try {
        const result = (await this.refLocators([params]))[0];
        debugRefRecovery('retry succeeded for ref=%s', params.ref);
        return result;
      } catch {
        debugRefRecovery('retry failed for ref=%s — trying role+name fallback', params.ref);
        return await this._refFallbackByRoleName(params, firstError as Error);
      }
    }
  }

  async refLocators(params: { element?: string, ref: string }[]): Promise<{ locator: Locator, resolved: string }[]> {
    await this._initializedPromise;
    return Promise.all(params.map(async param => {
      try {
        let locator = this.page.locator(`aria-ref=${param.ref}`);
        if (param.element)
          locator = locator.describe(param.element);
        const { resolvedSelector } = await locator._resolveSelector();
        return { locator, resolved: asLocator('javascript', resolvedSelector) };
      } catch (e) {
        throw new Error(`Ref ${param.ref} not found in the current page snapshot. Try capturing new snapshot.`);
      }
    }));
  }

  private _parseRefMetadata(snapshotText: string) {
    // Do NOT clear — stale ref metadata must survive for the role+name fallback.
    // captureSnapshot() is called on every Response (even includeSnapshot:'none'),
    // so clearing would wipe metadata for refs that went stale between snapshots.
    // Snapshot format: "- role "name" [attr] [ref=eNN] [cursor=pointer]"
    // Name is JSON.stringify'd (double-quoted) or regex (/pattern/). Optional.
    // Attributes appear between name and [ref=...]. [ref=...] is always last before optional [cursor=pointer].
    const refPattern = /- (\w+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*(?:\[[^\]]*\]\s*)*\[ref=(\w+)\]/g;
    let match;
    while ((match = refPattern.exec(snapshotText)) !== null) {
      const [, role, name, ref] = match;
      this._refMetadata.set(ref, { role, name: name ?? '' });
    }
  }

  private async _refFallbackByRoleName(params: { element?: string, ref: string }, originalError: Error): Promise<{ locator: Locator, resolved: string }> {
    const meta = this._refMetadata.get(params.ref);
    if (!meta?.name) {
      debugRefRecovery('fallback skip: ref=%s has no name metadata', params.ref);
      throw originalError;
    }
    const locator = this.page.getByRole(meta.role as any, { name: meta.name, exact: true });
    const count = await locator.count();
    if (count !== 1) {
      debugRefRecovery('fallback skip: ref=%s role=%s name=%s matched %d elements (need exactly 1)', params.ref, meta.role, meta.name.slice(0, 50), count);
      throw originalError;
    }
    if (params.element)
      locator.describe(params.element);
    const { resolvedSelector } = await locator._resolveSelector();
    debugRefRecovery('fallback succeeded: ref=%s → role=%s name=%s', params.ref, meta.role, meta.name.slice(0, 50));
    return { locator, resolved: asLocator('javascript', resolvedSelector) };
  }

  async waitForTimeout(time: number) {
    return this.context.perfLog.timeAsync({
      phase: 'waitForTimeout', step: 'sleep',
      side: this._javaScriptBlocked() ? 'server' : 'chrome',
      target_ms: time,
    }, async () => {
      if (this._javaScriptBlocked()) {
        await new Promise(f => setTimeout(f, time));
        return;
      }

      await callOnPageNoTrace(this.page, page => {
        return page.evaluate((ms) => new Promise(f => setTimeout(f, ms)), time).catch(() => {});
      });
    });
  }
}

export type ConsoleMessageLocation = {
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type ConsoleMessage = {
  type: ReturnType<playwright.ConsoleMessage['type']>;
  timestamp: number;
  text: string;
  location: ConsoleMessageLocation;
  toString(): string;
};

function messageToConsoleMessage(message: playwright.ConsoleMessage): ConsoleMessage {
  const location = message.location();
  return {
    type: message.type(),
    timestamp: message.timestamp(),
    text: message.text(),
    location,
    toString: () => `[${message.type().toUpperCase()}] ${message.text()} @ ${location.url}:${location.lineNumber}`,
  };
}

function pageErrorToConsoleMessage(errorOrValue: Error | any): ConsoleMessage {
  const emptyLocation: ConsoleMessageLocation = { url: '', lineNumber: 0, columnNumber: 0 };
  if (errorOrValue instanceof Error) {
    return {
      type: 'error',
      timestamp: Date.now(),
      text: errorOrValue.message,
      location: emptyLocation,
      toString: () => errorOrValue.stack || errorOrValue.message,
    };
  }
  return {
    type: 'error',
    timestamp: Date.now(),
    text: String(errorOrValue),
    location: emptyLocation,
    toString: () => String(errorOrValue),
  };
}

export function renderModalStates(config: ContextConfig, modalStates: ModalState[]): string[] {
  const result: string[] = [];
  if (modalStates.length === 0)
    result.push('- There is no modal state present');
  for (const state of modalStates)
    result.push(`- [${state.description}]: can be handled by ${config.skillMode ? state.clearedBy.skill : state.clearedBy.tool}`);
  return result;
}

type ConsoleMessageType = ReturnType<playwright.ConsoleMessage['type']>;
type ConsoleMessageLevel = 'error' | 'warning' | 'info' | 'debug';
const consoleMessageLevels: ConsoleMessageLevel[] = ['error', 'warning', 'info', 'debug'];

export function shouldIncludeMessage(thresholdLevel: ConsoleMessageLevel | undefined, type: ConsoleMessageType): boolean {
  const messageLevel = consoleLevelForMessageType(type);
  return consoleMessageLevels.indexOf(messageLevel) <= consoleMessageLevels.indexOf(thresholdLevel || 'info');
}

export function consoleLevelForMessageType(type: ConsoleMessageType): ConsoleMessageLevel {
  switch (type) {
    case 'assert':
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'count':
    case 'dir':
    case 'dirxml':
    case 'info':
    case 'log':
    case 'table':
    case 'time':
    case 'timeEnd':
      return 'info';
    case 'clear':
    case 'debug':
    case 'endGroup':
    case 'profile':
    case 'profileEnd':
    case 'startGroup':
    case 'startGroupCollapsed':
    case 'trace':
      return 'debug';
    default:
      return 'info';
  }
}

const tabSymbol = Symbol('tabSymbol');

function sanitizeForFilePath(s: string) {
  const sanitize = (s: string) => s.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
  const separator = s.lastIndexOf('.');
  if (separator === -1)
    return sanitize(s);
  return sanitize(s.substring(0, separator)) + '.' + sanitize(s.substring(separator + 1));
}

function tabHeaderEquals(a: TabHeader, b: TabHeader): boolean {
  return a.title === b.title &&
      a.url === b.url &&
      a.current === b.current &&
      a.console.errors === b.console.errors &&
      a.console.warnings === b.console.warnings &&
      a.console.total === b.console.total;
}
