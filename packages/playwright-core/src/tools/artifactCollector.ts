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

import { LogFile } from './logFile';

import type { Context, ContextConfig } from './context';
import type { ModalState } from './tool';
import type * as playwright from '../../types/types';

export type Download = {
  download: playwright.Download;
  finished: boolean;
  outputFile: string;
};

export type ConsoleLogEntry = {
  type: 'console';
  wallTime: number;
  message: ConsoleMessage;
};

export type DownloadStartLogEntry = {
  type: 'download-start';
  wallTime: number;
  download: Download;
};

export type DownloadFinishLogEntry = {
  type: 'download-finish';
  wallTime: number;
  download: Download;
};

export type EventEntry = ConsoleLogEntry | DownloadStartLogEntry | DownloadFinishLogEntry;

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

export type ConsoleMessageType = ReturnType<playwright.ConsoleMessage['type']>;
export type ConsoleMessageLevel = 'error' | 'warning' | 'info' | 'debug';
export const consoleMessageLevels: ConsoleMessageLevel[] = ['error', 'warning', 'info', 'debug'];

export function messageToConsoleMessage(message: playwright.ConsoleMessage): ConsoleMessage {
  const location = message.location();
  return {
    type: message.type(),
    timestamp: message.timestamp(),
    text: message.text(),
    location,
    toString: () => `[${message.type().toUpperCase()}] ${message.text()} @ ${location.url}:${location.lineNumber}`,
  };
}

export function pageErrorToConsoleMessage(errorOrValue: Error | any): ConsoleMessage {
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

export class ArtifactCollector {
  private _context: Context;
  private _downloads: Download[] = [];
  private _requests: playwright.Request[] = [];
  private _recentEventEntries: EventEntry[] = [];
  private _consoleLog: LogFile;

  constructor(context: Context) {
    this._context = context;
    const wallTime = Date.now();
    this._consoleLog = new LogFile(this._context, wallTime, 'console', 'Console');
  }

  downloadStarted(download: playwright.Download, outputFile: string) {
    const entry: Download = { download, finished: false, outputFile };
    this._downloads.push(entry);
    this._addLogEntry({ type: 'download-start', wallTime: Date.now(), download: entry });
    void download.saveAs(entry.outputFile).then(() => {
      entry.finished = true;
      this._addLogEntry({ type: 'download-finish', wallTime: Date.now(), download: entry });
    });
    return entry;
  }

  clearCollectedArtifacts() {
    this._downloads.length = 0;
    this._requests.length = 0;
    this._recentEventEntries.length = 0;
    this.resetLogs();
  }

  private resetLogs() {
    const wallTime = Date.now();
    this._consoleLog.stop();
    this._consoleLog = new LogFile(this._context, wallTime, 'console', 'Console');
  }

  handleRequest(request: playwright.Request) {
    this._requests.push(request);
  }

  handleResponse(_response: playwright.Response) {
  }

  handleRequestFailed(request: playwright.Request) {
    this._requests.push(request);
  }

  handleConsoleMessage(message: ConsoleMessage) {
    const wallTime = message.timestamp;
    this._addLogEntry({ type: 'console', wallTime, message });
    const level = consoleLevelForMessageType(message.type);
    if (level === 'error' || level === 'warning') {
      const excludePatterns = this._context.config.console?.excludePatterns;
      const excluded = excludePatterns?.length && message.location.url &&
        excludePatterns.some(pattern => message.location.url.startsWith(pattern));
      if (!excluded)
        this._consoleLog.appendLine(wallTime, () => message.toString());
    }
  }

  private _addLogEntry(entry: EventEntry) {
    this._recentEventEntries.push(entry);
  }

  consoleMessageCount(page: playwright.Page): Promise<{ total: number, errors: number, warnings: number }> {
    return (async () => {
      const messages = await page.consoleMessages();
      const pageErrors = await page.pageErrors();
      let errors = pageErrors.length;
      let warnings = 0;
      for (const message of messages) {
        if (message.type() === 'error')
          errors++;
        else if (message.type() === 'warning')
          warnings++;
      }
      return { total: messages.length + pageErrors.length, errors, warnings };
    })();
  }

  async consoleMessages(page: playwright.Page, level: ConsoleMessageLevel, excludePatterns?: string[]): Promise<ConsoleMessage[]> {
    const result: ConsoleMessage[] = [];
    const messages = await page.consoleMessages();
    for (const message of messages) {
      const cm = messageToConsoleMessage(message);
      if (excludePatterns?.length && cm.location.url &&
          excludePatterns.some(p => cm.location.url.startsWith(p)))
        continue;
      if (shouldIncludeMessage(level, cm.type))
        result.push(cm);
    }
    if (shouldIncludeMessage(level, 'error')) {
      const errors = await page.pageErrors();
      for (const error of errors)
        result.push(pageErrorToConsoleMessage(error));
    }
    return result;
  }

  async clearConsoleMessages(page: playwright.Page): Promise<void> {
    await Promise.all([
      page.clearConsoleMessages(),
      page.clearPageErrors()
    ]);
  }

  requests(): playwright.Request[] {
    return this._requests;
  }

  clearRequests() {
    this._requests.length = 0;
  }

  async takeConsoleLog(relativeTo: string | undefined): Promise<string | undefined> {
    return this._consoleLog.take(relativeTo);
  }

  drainEvents(): EventEntry[] {
    const events = this._recentEventEntries;
    this._recentEventEntries = [];
    return events;
  }

  stopLog() {
    this._consoleLog.stop();
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
}
