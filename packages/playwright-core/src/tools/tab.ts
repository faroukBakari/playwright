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
import { ManualPromise } from '../utils/isomorphic/manualPromise';
import { debug } from '../utilsBundle';

import { eventsHelper } from '../client/eventEmitter';
import { callOnPageNoTrace, waitForCompletion, eventWaiter } from './utils';
import { ModalState } from './tool';
import { handleDialog } from './dialogs';
import { uploadFile } from './files';
import { disposeAll } from '../client/disposable';
import { ArtifactCollector, messageToConsoleMessage, pageErrorToConsoleMessage, type ConsoleMessageLevel } from './artifactCollector';
import { SnapshotOrchestrator } from './snapshotOrchestrator';
import type { TabSnapshot } from './snapshotOrchestrator';
import { RefResolver } from './refResolver';

export { renderModalStates, shouldIncludeMessage, consoleLevelForMessageType } from './artifactCollector';
export type { ConsoleMessage, ConsoleMessageLocation, ConsoleMessageLevel, EventEntry } from './artifactCollector';
export type { TabSnapshot } from './snapshotOrchestrator';

import type { Disposable } from '../client/disposable';
import type { Context } from './context';
import type { Page } from '../client/page';
import type * as playwright from '../../types/types';

const TabEvents = {
  modalState: 'modalState'
};

type TabEventsInterface = {
  [TabEvents.modalState]: [modalState: ModalState];
};

export type TabHeader = {
  title: string;
  url: string;
  current: boolean;
  console: { total: number, warnings: number, errors: number };
};

export class Tab extends EventEmitter<TabEventsInterface> {
  readonly context: Context;
  readonly page: Page;
  private _lastHeader: TabHeader = { title: 'about:blank', url: 'about:blank', current: false, console: { total: 0, warnings: 0, errors: 0 } };
  private _onPageClose: (tab: Tab) => void;
  private _modalStates: ModalState[] = [];
  private _initializedPromise: Promise<void>;
  private _disposables: Disposable[];
  private _actionTimeoutCeiling: number | undefined;
  private _navigationTimeoutCeiling: number | undefined;
  private _expectTimeoutCeiling: number | undefined;
  private _artifactCollector: ArtifactCollector;
  private _snapshotOrchestrator: SnapshotOrchestrator;
  private _refResolver: RefResolver;

  constructor(context: Context, page: playwright.Page, onPageClose: (tab: Tab) => void) {
    super();
    this.context = context;
    this.page = page as Page;
    this._onPageClose = onPageClose;
    this._artifactCollector = new ArtifactCollector(context);
    this._snapshotOrchestrator = new SnapshotOrchestrator(context, page as Page);
    this._refResolver = new RefResolver(context, page as Page);
    const p = page as Page;
    this._disposables = [
      eventsHelper.addEventListener(p, 'console', event => this._artifactCollector.handleConsoleMessage(messageToConsoleMessage(event))),
      eventsHelper.addEventListener(p, 'pageerror', error => this._artifactCollector.handleConsoleMessage(pageErrorToConsoleMessage(error))),
      eventsHelper.addEventListener(p, 'request', request => this._artifactCollector.handleRequest(request)),
      eventsHelper.addEventListener(p, 'response', response => this._artifactCollector.handleResponse(response)),
      eventsHelper.addEventListener(p, 'requestfailed', request => this._artifactCollector.handleRequestFailed(request)),
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
    this._initializedPromise = this._initialize();
    this._actionTimeoutCeiling = context.config.timeouts?.playwright?.action;
    this._navigationTimeoutCeiling = context.config.timeouts?.playwright?.navigation;
    this._expectTimeoutCeiling = context.config.timeouts?.playwright?.expect;
  }

  async dispose() {
    await disposeAll(this._disposables);
    this._artifactCollector.stopLog();
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

  // Screenshots are not subject to the action ceiling — they should use the
  // full remaining budget. Calling _minTimeout(undefined) skips all ceilings.
  get screenshotTimeoutOptions(): { timeout?: number } {
    return { timeout: this._minTimeout(undefined) };
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

  static async collectConsoleMessages(page: playwright.Page) {
    return ArtifactCollector.collectConsoleMessages(page);
  }

  private async _initialize() {
    for (const message of await ArtifactCollector.collectConsoleMessages(this.page))
      this._artifactCollector.handleConsoleMessage(message);
    const requests = await this.page.requests().catch(() => []);
    for (const request of requests.filter(r => r.existingResponse() || r.failure()))
      this._artifactCollector.handleRequest(request);
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
    this._artifactCollector.downloadStarted(download, outputFile);
  }

  private _onClose() {
    this._artifactCollector.clearCollectedArtifacts();
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
    this._artifactCollector.clearCollectedArtifacts();

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
    return this._artifactCollector.consoleMessageCount(this.page);
  }

  async consoleMessages(level: ConsoleMessageLevel, excludePatterns?: string[]) {
    await this._initializedPromise;
    return this._artifactCollector.consoleMessages(this.page, level, excludePatterns);
  }

  async clearConsoleMessages() {
    await this._initializedPromise;
    await this._artifactCollector.clearConsoleMessages(this.page);
  }

  async requests(): Promise<playwright.Request[]> {
    await this._initializedPromise;
    return this._artifactCollector.requests();
  }

  async clearRequests() {
    await this._initializedPromise;
    this._artifactCollector.clearRequests();
  }

  async captureSnapshot(relativeTo: string | undefined, options?: { rootSelector?: string; clientId?: string }): Promise<TabSnapshot> {
    await this._initializedPromise;
    return this._snapshotOrchestrator.captureSnapshot(relativeTo, options, {
      raceAgainstModalStates: action => this._raceAgainstModalStates(action),
      takeConsoleLog: rel => this._artifactCollector.takeConsoleLog(rel),
      drainEvents: () => this._artifactCollector.drainEvents(),
      updateRefMetadata: text => this._refResolver.parseRefMetadata(text),
    });
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

  async refLocator(params: { element?: string, ref: string }) {
    await this._initializedPromise;
    return this._refResolver.refLocator(params);
  }

  async refLocators(params: { element?: string, ref: string }[]) {
    await this._initializedPromise;
    return this._refResolver.refLocators(params);
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
