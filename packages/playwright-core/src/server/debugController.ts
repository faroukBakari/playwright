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

// DebugController/codegen stripped from this build.
// Stub satisfies imports from server/playwright.ts and dispatchers.

import { SdkObject, createInstrumentation } from './instrumentation';

import type { Language } from '../utils';
import type { Playwright } from './playwright';
import type { Progress } from './progress';

export class DebugController extends SdkObject {
  static Events = {
    StateChanged: 'stateChanged',
    InspectRequested: 'inspectRequested',
    SourceChanged: 'sourceChanged',
    Paused: 'paused',
    SetModeRequested: 'setModeRequested',
  };

  _sdkLanguage: Language = 'javascript';
  _generateAutoExpect = false;

  constructor(_playwright: Playwright) {
    super({ attribution: { isInternalPlaywright: true }, instrumentation: createInstrumentation() } as any, undefined, 'DebugController');
  }

  initialize(_codegenId: string, sdkLanguage: Language) {
    this._sdkLanguage = sdkLanguage;
  }

  dispose() {}

  setAutoClose(_enabled: boolean) {}
  setRecorderMode(_progress: Progress, _params: any) {}
  resetForReuse() {}
  navigateAll(_url: string) {}
  setReportStateChanged(_enabled: boolean) {}

  async highlight(_progress: Progress, _params: any) {}
  async hideHighlight(_progress: Progress) {}
  async resume(_progress: Progress) {}
  async kill() {}
  async closeAllBrowsers() {}
}
