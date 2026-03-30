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
import { renderModalStates, shouldIncludeMessage, consoleLevelForMessageType } from './artifactCollector';
import { scaleImageToFitMessage } from './screenshot';

import type { TabHeader } from './tab';
import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { Context, FilenameTemplate } from './context';
import type { SnapshotMode } from './snapshotOptions';

export const requestDebug = debug('pw:mcp:request');

type ResolvedFile = {
  fileName: string;
  relativeName: string;
  printableLink: string;
};

type Section = {
  title: string;
  content: string[];
  isError?: boolean;
  codeframe?: 'yaml' | 'js';
};

export class Response {
  private _results: string[] = [];
  private _errors: string[] = [];
  private _code: string[] = [];
  private _context: Context;
  private _includeSnapshot: SnapshotMode = 'none';
  private _includeSnapshotFileName: string | undefined;
  private _isClose: boolean = false;
  private _snapshotSelector: string | undefined;
  private _snapshotMode: SnapshotMode | undefined;
  private _snapshotWaitFor?: { text?: string; textGone?: string; selector?: string; within?: string };

  readonly toolName: string;
  readonly toolArgs: Record<string, any>;
  private _clientWorkspace: string;
  private _imageResults: { data: Buffer, imageType: 'png' | 'jpeg' }[] = [];

  constructor(context: Context, toolName: string, toolArgs: Record<string, any>, relativeTo?: string, snapshotSelector?: string, snapshotMode?: SnapshotMode) {
    this._context = context;
    this.toolName = toolName;
    this.toolArgs = toolArgs;
    this._clientWorkspace = relativeTo ?? context.options.cwd;
    this._snapshotSelector = snapshotSelector;
    this._snapshotMode = snapshotMode;
  }

  private _computRelativeTo(fileName: string): string {
    return path.relative(this._clientWorkspace, fileName);
  }

  async resolveClientFile(template: FilenameTemplate, title: string): Promise<ResolvedFile> {
    let fileName: string;
    if (template.suggestedFilename)
      fileName = await this._context.workspaceFile(template.suggestedFilename, this._clientWorkspace);
    else
      fileName = await this._context.outputFile(template, { origin: 'llm' });
    const relativeName = this._computRelativeTo(fileName);
    const printableLink = `- [${title}](${relativeName})`;
    return { fileName, relativeName, printableLink };
  }

  addTextResult(text: string) {
    this._results.push(text);
  }

  async addResult(title: string, data: Buffer | string, file: FilenameTemplate) {
    if (this._context.config.outputMode === 'file' || file.suggestedFilename || typeof data !== 'string') {
      const resolvedFile = await this.resolveClientFile(file, title);
      await this.addFileResult(resolvedFile, data);
    } else {
      this.addTextResult(data);
    }
  }

  async addFileResult(resolvedFile: ResolvedFile, data: Buffer | string | null) {
    if (typeof data === 'string')
      await fs.promises.writeFile(resolvedFile.fileName, data, 'utf-8');
    else if (data)
      await fs.promises.writeFile(resolvedFile.fileName, data);
    this.addTextResult(resolvedFile.printableLink);
  }

  addFileLink(title: string, fileName: string) {
    const relativeName = this._computRelativeTo(fileName);
    this.addTextResult(`- [${title}](${relativeName})`);
  }

  async registerImageResult(data: Buffer, imageType: 'png' | 'jpeg') {
    this._imageResults.push({ data, imageType });
  }

  setClose() {
    this._isClose = true;
  }

  addError(error: string) {
    this._errors.push(error);
  }

  addCode(code: string) {
    this._code.push(code);
  }

  setSnapshotWaitFor(waitFor: { text?: string; textGone?: string; selector?: string; within?: string } | undefined) {
    this._snapshotWaitFor = waitFor;
  }

  setIncludeSnapshot(mode?: SnapshotMode, selector?: string, fileName?: string) {
    if (this._snapshotMode === 'none')
      return;
    if (mode) {
      // Handler explicit mode (e.g. browser_snapshot → 'full')
      this._includeSnapshot = mode;
    } else if (this._snapshotMode) {
      // Caller-specified mode from MCP params (e.g. includeSnapshot: 'diff')
      this._includeSnapshot = this._snapshotMode;
    } else {
      // No explicit mode — resolve from config (map 'incremental' → 'diff')
      const configMode = this._context.config.snapshot?.mode;
      this._includeSnapshot = configMode === 'none' ? 'none'
        : configMode === 'full' ? 'full' : 'diff';
    }
    if (selector !== undefined)
      this._snapshotSelector = selector;
    if (fileName !== undefined)
      this._includeSnapshotFileName = fileName;
  }

  async serialize(): Promise<CallToolResult> {
    const redactText = (text: string): string => {
      for (const [secretName, secretValue] of Object.entries(this._context.config.secrets ?? {}))
        text = text.replaceAll(secretValue, `<secret>${secretName}</secret>`);
      return text;
    };

    const sections = await this._build();

    const text: string[] = [];
    for (const section of sections) {
      if (!section.content.length)
        continue;
      text.push(`### ${section.title}`);
      if (section.codeframe)
        text.push(`\`\`\`${section.codeframe}`);
      text.push(...section.content);
      if (section.codeframe)
        text.push('```');
    }

    let joined = text.join('\n');
    const maxChars = this._context.config.maxResponseChars;
    if (maxChars && joined.length > maxChars) {
      // Find the largest truncatable section (Result or Snapshot) and trim it
      const truncatable = sections
          .filter(s => !s.isError && s.title !== 'Page' && s.title !== 'Error' && s.content.length)
          .sort((a, b) => b.content.join('\n').length - a.content.join('\n').length);
      if (truncatable.length) {
        const target = truncatable[0];
        const excess = joined.length - maxChars;
        const sectionText = target.content.join('\n');
        const trimmedLen = Math.max(0, sectionText.length - excess - 100); // 100 for footer
        target.content.splice(0, target.content.length, sectionText.slice(0, trimmedLen) + `\n... [response truncated to fit ${maxChars} char limit]`);
        // Rebuild
        const rebuilt: string[] = [];
        for (const section of sections) {
          if (!section.content.length)
            continue;
          rebuilt.push(`### ${section.title}`);
          if (section.codeframe)
            rebuilt.push(`\`\`\`${section.codeframe}`);
          rebuilt.push(...section.content);
          if (section.codeframe)
            rebuilt.push('```');
        }
        joined = rebuilt.join('\n');
      }
    }

    const content: (TextContent | ImageContent)[] = [
      {
        type: 'text',
        text: redactText(joined),
      }
    ];

    // Image attachments.
    if (this._context.config.imageResponses !== 'omit') {
      for (const imageResult of this._imageResults) {
        const scaledData = scaleImageToFitMessage(imageResult.data, imageResult.imageType);
        content.push({ type: 'image', data: scaledData.toString('base64'), mimeType: imageResult.imageType === 'png' ? 'image/png' : 'image/jpeg' });
      }
    }

    return {
      content,
      ...(this._isClose ? { isClose: true } : {}),
      ...(sections.some(section => section.isError) ? { isError: true } : {}),
    };
  }

  private async _build(): Promise<Section[]> {
    const sections: Section[] = [];
    const addSection = (title: string, content: string[], codeframe?: 'yaml' | 'js') => {
      const section = { title, content, isError: title === 'Error', codeframe };
      sections.push(section);
      return content;
    };

    if (this._errors.length)
      addSection('Error', this._errors);

    const resultContent = addSection('Result', this._results);

    // Code
    if (this._context.config.codegen !== 'none' && this._code.length)
      addSection('Ran Playwright code', this._code, 'js');

    // Render tab titles upon changes or when more than one tab.
    if (this._snapshotSelector)
      requestDebug('snapshotSelector=%s for tool=%s', this._snapshotSelector, this.toolName);
    const hasTab = !!this._context.currentTab();
    const wantsSnapshot = this._includeSnapshot !== 'none';

    // Execute snapshotWaitFor condition before capture
    if (this._snapshotWaitFor && hasTab && wantsSnapshot) {
      const tab = this._context.currentTabOrDie();
      const waitForTimeout = Math.min(
        this._context.config.snapshot?.waitForTimeout ?? 3000,
        this._context.remainingBudget()
      );
      const perf = this._context.perfLog;
      try {
        const within = this._snapshotWaitFor.within;
        if (this._snapshotWaitFor.text) {
          await perf.timeAsync({
            phase: 'snapshot', step: 'snapshotWaitFor', side: 'chrome',
            target_ms: waitForTimeout, condition: 'text', value: this._snapshotWaitFor.text,
            ...(within ? { within } : {}),
          }, () => tab.page.waitForFunction(
            ([text, within]: [string, string | undefined]) => {
              let root: HTMLElement | null = within ? document.querySelector<HTMLElement>(within) : null;
              if (within && !root) {
                for (const iframe of document.querySelectorAll('iframe')) {
                  try {
                    root = iframe.contentDocument?.querySelector<HTMLElement>(within) ?? null;
                    if (root) break;
                  } catch { /* cross-origin — skip */ }
                }
              }
              if (!root) root = document.body;
              return root?.innerText?.includes(text) ?? false;
            },
            [this._snapshotWaitFor!.text!, within] as [string, string | undefined],
            { timeout: waitForTimeout }
          ));
        } else if (this._snapshotWaitFor.textGone) {
          await perf.timeAsync({
            phase: 'snapshot', step: 'snapshotWaitFor', side: 'chrome',
            target_ms: waitForTimeout, condition: 'textGone', value: this._snapshotWaitFor.textGone,
            ...(within ? { within } : {}),
          }, () => tab.page.waitForFunction(
            ([text, within]: [string, string | undefined]) => {
              let root: HTMLElement | null = within ? document.querySelector<HTMLElement>(within) : null;
              if (within && !root) {
                for (const iframe of document.querySelectorAll('iframe')) {
                  try {
                    root = iframe.contentDocument?.querySelector<HTMLElement>(within) ?? null;
                    if (root) break;
                  } catch { /* cross-origin — skip */ }
                }
              }
              if (!root) root = document.body;
              return !(root?.innerText?.includes(text) ?? false);
            },
            [this._snapshotWaitFor!.textGone!, within] as [string, string | undefined],
            { timeout: waitForTimeout }
          ));
        } else if (this._snapshotWaitFor.selector) {
          await perf.timeAsync({
            phase: 'snapshot', step: 'snapshotWaitFor', side: 'chrome',
            target_ms: waitForTimeout, condition: 'selector', value: this._snapshotWaitFor.selector,
          }, () => tab.page.waitForSelector(this._snapshotWaitFor!.selector!, { timeout: waitForTimeout }));
        }
      } catch (e) {
        // Timeout is not fatal — capture snapshot anyway with current state
        if (e instanceof Error && e.name === 'TimeoutError')
          resultContent.push(`snapshotWaitFor timed out after ${waitForTimeout}ms — snapshot shows current state`);
        else
          throw e;
      }
    }

    const tabSnapshot = hasTab && wantsSnapshot ? await this._context.currentTabOrDie().captureSnapshot(this._clientWorkspace, { rootSelector: this._snapshotSelector, clientId: this._context.id }) : undefined;
    if (tabSnapshot?.selectorResolved === false && this._snapshotSelector)
      resultContent.push(`snapshotSelector '${this._snapshotSelector}' matched no elements — returning full page snapshot`);
    if (tabSnapshot?.selectorResolved === true && this._snapshotSelector)
      resultContent.push(`selectorResolved: true — snapshotSelector '${this._snapshotSelector}' matched`);
    requestDebug('tool=%s snapshot=%s hasTab=%s', this.toolName, this._includeSnapshot, hasTab);
    const tabHeaders = wantsSnapshot ? await Promise.all(this._context.tabs().map(tab => tab.headerSnapshot())) : [];
    if (wantsSnapshot || tabHeaders.some(header => header.changed)) {
      if (tabHeaders.length !== 1)
        addSection('Open tabs', renderTabsMarkdown(tabHeaders));
      addSection('Page', renderTabMarkdown(tabHeaders.find(h => h.current) ?? tabHeaders[0]));
    }
    if (this._context.tabs().length === 0)
      this._isClose = true;

    // Handle modal states.
    if (tabSnapshot?.modalStates.length)
      addSection('Modal state', renderModalStates(this._context.config, tabSnapshot.modalStates));

    // Handle tab snapshot
    if (tabSnapshot && this._includeSnapshot !== 'none') {
      // For diff mode: empty string means "nothing changed" (distinct from undefined which means "no baseline").
      // undefined → fall back to full (first capture); empty string → emit no-changes marker.
      // Exception: both ariaSnapshotDiff AND ariaSnapshot empty means content was removed
      // (e.g. SPA navigation emptied a scoped element) — not a legitimate "no changes".
      let snapshot: string;
      if (this._includeSnapshot === 'full') {
        snapshot = tabSnapshot.ariaSnapshot;
      } else if (tabSnapshot.ariaSnapshotDiff !== undefined) {
        if (tabSnapshot.ariaSnapshotDiff === '' && !tabSnapshot.ariaSnapshot)
          snapshot = '[empty page]';
        else
          snapshot = tabSnapshot.ariaSnapshotDiff || '[no changes]';
      } else {
        snapshot = tabSnapshot.ariaSnapshot;
      }
      const maxChars = this._context.config.snapshot?.maxChars;
      if (maxChars && snapshot.length > maxChars)
        snapshot = snapshot.slice(0, maxChars) + `\n... [truncated: ${snapshot.length} chars, limit ${maxChars}]`;
      if (this._context.config.outputMode === 'file' || this._includeSnapshotFileName) {
        const resolvedFile = await this.resolveClientFile({ prefix: 'page', ext: 'yml', suggestedFilename: this._includeSnapshotFileName }, 'Snapshot');
        await fs.promises.writeFile(resolvedFile.fileName, snapshot, 'utf-8');
        addSection('Snapshot', [resolvedFile.printableLink]);
      } else {
        addSection('Snapshot', [snapshot], 'yaml');
      }
    }

    // Handle tab log
    const text: string[] = [];
    if (tabSnapshot?.consoleLink)
      text.push(`- New console entries: ${tabSnapshot.consoleLink}`);
    if (tabSnapshot?.events.length) {
      // Per-call overrides from tool args, falling back to config defaults
      const excludePatterns: string[] | undefined = this.toolArgs.consoleExcludePatterns ?? this._context.config.console?.excludePatterns;
      const maxEvents: number | undefined = this.toolArgs.consoleMaxEvents ?? this._context.config.console?.maxEvents;

      const consoleLines: string[] = [];
      let lastConsoleStr: string | undefined;
      let lastConsoleCount = 0;

      const flushConsoleGroup = () => {
        if (lastConsoleStr !== undefined) {
          const prefix = lastConsoleCount > 1 ? `(${lastConsoleCount}×) ` : '';
          consoleLines.push(`- ${prefix}${lastConsoleStr}`);
        }
      };

      for (const event of tabSnapshot.events) {
        if (event.type === 'console' && this._context.config.outputMode !== 'file') {
          // Exclude by URL prefix pattern
          if (excludePatterns?.length && event.message.location.url &&
              excludePatterns.some(p => event.message.location.url.startsWith(p)))
            continue;
          const level = consoleLevelForMessageType(event.message.type);
          const isHighSeverity = level === 'error' || level === 'warning';
          if (isHighSeverity || this._context.config.snapshot?.mode !== 'none') {
            if (shouldIncludeMessage(this._context.config.console?.level, event.message.type)) {
              const str = trimMiddle(event.message.toString(), 100);
              if (str === lastConsoleStr) {
                lastConsoleCount++;
              } else {
                flushConsoleGroup();
                lastConsoleStr = str;
                lastConsoleCount = 1;
              }
            }
          }
        } else if (event.type === 'download-start') {
          text.push(`- Downloading file ${event.download.download.suggestedFilename()} ...`);
        } else if (event.type === 'download-finish') {
          text.push(`- Downloaded file ${event.download.download.suggestedFilename()} to "${this._computRelativeTo(event.download.outputFile)}"`);
        }
      }
      flushConsoleGroup();

      // Apply maxEvents tail limit
      if (maxEvents !== undefined && consoleLines.length > maxEvents) {
        const omitted = consoleLines.length - maxEvents;
        const tail = consoleLines.slice(-maxEvents);
        text.push(`- [${omitted} earlier console entries omitted]`);
        text.push(...tail);
      } else {
        text.push(...consoleLines);
      }
    }
    if (text.length)
      addSection('Events', text);
    return sections;
  }
}

export function renderTabMarkdown(tab: TabHeader): string[] {
  const lines = [`- Page URL: ${tab.url}`];
  if (tab.title)
    lines.push(`- Page Title: ${tab.title}`);
  if (tab.console.errors || tab.console.warnings)
    lines.push(`- Console: ${tab.console.errors} errors, ${tab.console.warnings} warnings`);
  return lines;
}

export function renderTabsMarkdown(tabs: TabHeader[]): string[] {
  if (!tabs.length)
    return ['No open tabs. Navigate to a URL to create one.'];

  const lines: string[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const current = tab.current ? ' (current)' : '';
    lines.push(`- ${i}:${current} [${tab.title}](${tab.url})`);
  }
  return lines;
}

function trimMiddle(text: string, maxLength: number) {
  if (text.length <= maxLength)
    return text;
  return text.slice(0, Math.floor(maxLength / 2)) + '...' + text.slice(- 3 - Math.floor(maxLength / 2));
}

function parseSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const sectionHeaders = text.split(/^### /m).slice(1); // Remove empty first element

  for (const section of sectionHeaders) {
    const firstNewlineIndex = section.indexOf('\n');
    if (firstNewlineIndex === -1)
      continue;

    const sectionName = section.substring(0, firstNewlineIndex);
    const sectionContent = section.substring(firstNewlineIndex + 1).trim();
    sections.set(sectionName, sectionContent);
  }

  return sections;
}

export function parseResponse(response: CallToolResult) {
  if (response.content?.[0].type !== 'text')
    return undefined;
  const text = response.content[0].text;

  const sections = parseSections(text);
  const error = sections.get('Error');
  const result = sections.get('Result');
  const code = sections.get('Ran Playwright code');
  const tabs = sections.get('Open tabs');
  const page = sections.get('Page');
  const snapshot = sections.get('Snapshot');
  const events = sections.get('Events');
  const modalState = sections.get('Modal state');
  const codeNoFrame = code?.replace(/^```js\n/, '').replace(/\n```$/, '');
  const isError = response.isError;
  const attachments = response.content.length > 1 ? response.content.slice(1) : undefined;

  return {
    result,
    error,
    code: codeNoFrame,
    tabs,
    page,
    snapshot,
    events,
    modalState,
    isError,
    attachments,
    text,
  };
}
