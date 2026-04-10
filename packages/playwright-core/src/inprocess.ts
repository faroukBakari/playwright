/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License");
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

import { createInProcessPlaywright } from './inProcessFactory';

// Re-export types so `import * as playwright` consumers can reference
// `playwright.Browser`, `playwright.BrowserContext`, etc. in type position.
// Uses the public API types (types/types.d.ts) — not the internal classes —
// because BrowserType.connectOverCDP() returns the public interface.
export type { Browser, BrowserContext } from '../types/types';
export type { BrowserType } from './client/browserType';
export type { Selectors } from './client/selectors';
export type { Playwright } from './client/playwright';

const playwright = createInProcessPlaywright();

// Named exports for `import { chromium } from '../inprocess'` and
// `import * as pw from '../inprocess'; pw.chromium` patterns.
export const chromium = playwright.chromium;
export const devices = playwright.devices;
export const selectors = playwright.selectors;

// CommonJS default for `require('../inprocess')` callers.
module.exports = playwright;
