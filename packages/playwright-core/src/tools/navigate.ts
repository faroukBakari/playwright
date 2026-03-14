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

import { z } from '../mcpBundle';
import { defineTool, defineTabTool } from './tool';
import { resolveTimeout, handleText, handleSelector, handleUrl } from './wait';

const navigate = defineTool({
  capability: 'core-navigation',

  schema: {
    name: 'browser_navigate',
    title: 'Navigate to a URL',
    description: 'Navigate to a URL. Returns a page snapshot after loading. Pass includeSnapshot: false to suppress the snapshot when you only need navigation without page state.',
    inputSchema: z.object({
      url: z.string().describe('The URL to navigate to'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    const tab = await context.ensureTab();
    let url = params.url;
    try {
      new URL(url);
    } catch (e) {
      if (url.startsWith('localhost'))
        url = 'http://' + url;
      else
        url = 'https://' + url;
    }

    await tab.navigate(url);

    response.setIncludeSnapshot();
  },
});

const goBack = defineTabTool({
  capability: 'core-navigation',
  schema: {
    name: 'browser_navigate_back',
    title: 'Go back',
    description: 'Go back to the previous page in the history',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    await tab.page.goBack({ waitUntil: 'commit', ...tab.navigationTimeoutOptions });
    response.setIncludeSnapshot();
  },
});

const goForward = defineTabTool({
  capability: 'core-navigation',
  skillOnly: true,
  schema: {
    name: 'browser_navigate_forward',
    title: 'Go forward',
    description: 'Go forward to the next page in the history',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    await tab.page.goForward({ waitUntil: 'commit', ...tab.navigationTimeoutOptions });
    response.setIncludeSnapshot();
  },
});

const reload = defineTabTool({
  capability: 'core-navigation',
  skillOnly: true,
  schema: {
    name: 'browser_reload',
    title: 'Reload the page',
    description: 'Reload the current page',
    inputSchema: z.object({}),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    await tab.page.reload({ waitUntil: 'domcontentloaded', ...tab.navigationTimeoutOptions });
    response.setIncludeSnapshot();
  },
});

const navigateAndWait = defineTool({
  capability: 'core-navigation',

  schema: {
    name: 'browser_navigate_and_wait',
    title: 'Navigate and wait',
    description: `Navigate to a URL, then wait for a condition before returning the snapshot. Combines browser_navigate + browser_wait_for into one call. Use when you know the page needs time to render dynamic content after navigation.`,
    inputSchema: z.object({
      url: z.string().describe('The URL to navigate to'),
      waitForText: z.string().optional().describe('Text to wait for after navigation'),
      waitForSelector: z.string().optional().describe('CSS selector to wait for after navigation'),
      waitForUrl: z.string().optional().describe('URL glob pattern to wait for (e.g. after redirects)'),
      timeout: z.number().optional().describe('Wait timeout in seconds (default 3)'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    // Phase 1: Navigate
    const tab = await context.ensureTab();
    let url = params.url;
    try {
      new URL(url);
    } catch (e) {
      if (url.startsWith('localhost'))
        url = 'http://' + url;
      else
        url = 'https://' + url;
    }
    await tab.navigate(url);

    // Phase 2: Wait for condition (if any specified)
    const conditionKeys = (['waitForText', 'waitForSelector', 'waitForUrl'] as const)
      .filter(k => params[k] !== undefined);

    if (conditionKeys.length > 1)
      throw new Error(`Only one wait condition per call, got: ${conditionKeys.join(', ')}`);

    if (conditionKeys.length === 1) {
      const key = conditionKeys[0];
      const value = params[key]!;
      const timeoutMs = resolveTimeout(tab, { timeout: params.timeout });

      if (key === 'waitForText')
        await handleText(tab, { text: value }, response, timeoutMs);
      else if (key === 'waitForSelector')
        await handleSelector(tab, { selector: value }, response, timeoutMs);
      else if (key === 'waitForUrl')
        await handleUrl(tab, { url: value }, response, timeoutMs);
    }

    response.setIncludeSnapshot();
  },
});

export default [
  navigate,
  navigateAndWait,
  goBack,
  goForward,
  reload,
];
