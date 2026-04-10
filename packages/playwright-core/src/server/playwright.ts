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

import { Chromium } from './chromium/chromium';
import { DebugController } from './debugController';
import { SdkObject, createRootSdkObject } from './instrumentation';

import type { BrowserType } from './browserType';
import type { Language } from '../utils';
import type { Browser } from './browser';
import type { Page } from './page';

type PlaywrightOptions = {
  sdkLanguage: Language;
  isInternalPlaywright?: boolean;
  isServer?: boolean;
};

export class Playwright extends SdkObject {
  readonly chromium: BrowserType;
  readonly options: PlaywrightOptions;
  readonly debugController: DebugController;
  private _allPages = new Set<Page>();
  private _allBrowsers = new Set<Browser>();

  constructor(options: PlaywrightOptions) {
    super(createRootSdkObject(), undefined, 'Playwright');
    this.options = options;
    this.attribution.playwright = this;
    this.instrumentation.addListener({
      onBrowserOpen: browser => this._allBrowsers.add(browser),
      onBrowserClose: browser => this._allBrowsers.delete(browser),
      onPageOpen: page => this._allPages.add(page),
      onPageClose: page => this._allPages.delete(page),
    }, null);
    this.chromium = new Chromium(this);
    this.debugController = new DebugController(this);
  }

  allBrowsers(): Browser[] {
    return [...this._allBrowsers];
  }

  allPages(): Page[] {
    return [...this._allPages];
  }
}

export function createPlaywright(options: PlaywrightOptions) {
  return new Playwright(options);
}
