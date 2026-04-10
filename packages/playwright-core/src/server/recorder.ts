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

// Recorder/codegen functionality stripped from this build.
// This stub satisfies imports from debugController.ts, devtoolsController.ts,
// pageDispatcher.ts, etc.

import EventEmitter from 'events';

import type { BrowserContext } from './browserContext';
import type { Progress } from './progress';
import type { AriaTemplateNode } from '@isomorphic/ariaSnapshot';
import type { ElementInfo, Mode } from '@recorder/recorderTypes';

export const RecorderEvent = {
  PausedStateChanged: 'pausedStateChanged',
  ModeChanged: 'modeChanged',
  ElementPicked: 'elementPicked',
  CallLogsUpdated: 'callLogsUpdated',
  UserSourcesChanged: 'userSourcesChanged',
  ActionAdded: 'actionAdded',
  SignalAdded: 'signalAdded',
  PageNavigated: 'pageNavigated',
  ContextClosed: 'contextClosed',
} as const;

export type RecorderEventMap = {
  [RecorderEvent.PausedStateChanged]: [paused: boolean];
  [RecorderEvent.ModeChanged]: [mode: Mode];
  [RecorderEvent.ElementPicked]: [elementInfo: ElementInfo, userGesture?: boolean];
  [RecorderEvent.CallLogsUpdated]: [callLogs: any[]];
  [RecorderEvent.UserSourcesChanged]: [sources: any[], pausedSourceId?: string];
  [RecorderEvent.ActionAdded]: [action: any];
  [RecorderEvent.SignalAdded]: [signal: any];
  [RecorderEvent.PageNavigated]: [url: string];
  [RecorderEvent.ContextClosed]: [];
};

export class Recorder extends EventEmitter<RecorderEventMap> {
  static async forContext(_context: BrowserContext, _options?: any): Promise<Recorder> {
    throw new Error('Recorder not available — stripped from this build');
  }

  static async existingForContext(_context: BrowserContext): Promise<Recorder | undefined> {
    return undefined;
  }

  async setMode(_mode: string) {}

  async pickLocator(_progress: Progress): Promise<string> {
    return '';
  }

  async setHighlightedSelector(_selector: string) {}

  async setHighlightedAriaTemplate(_template: AriaTemplateNode) {}

  async hideHighlightedSelector() {}

  resume() {}
}
