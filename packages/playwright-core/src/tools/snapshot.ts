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
import { formatObject, formatObjectOrVoid } from '../utils/isomorphic/stringUtils';

import { defineTabTool, defineTool } from './tool';

export const consoleOptionsSchema = z.object({
  consoleExcludePatterns: z.array(z.string()).optional().describe('URL prefix patterns to exclude from console output in Events section. Overrides config default (e.g. pass [] to see all messages including extension noise).'),
  consoleMaxEvents: z.number().optional().describe('Maximum console lines in Events section. Overrides config default.'),
});

const snapshot = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_snapshot',
    title: 'Page snapshot',
    description: 'Capture accessibility snapshot of the current page (interactable elements only). Returns element refs for interaction. Use snapshotSelector to scope to a DOM subtree (e.g. "header", ".sidebar"). Costly in tokens — prefer browser_evaluate for verification after actions.',
    inputSchema: z.object({
      filename: z.string().optional().describe('Save snapshot to markdown file instead of returning it in the response.'),
      snapshotSelector: z.string().optional().describe('CSS selector to scope the snapshot to a DOM subtree (e.g. "main", ".content"). Only elements within the matched subtree appear in the snapshot. Refs from prior full-page snapshots remain valid.'),
      ...consoleOptionsSchema.shape,
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    response.setIncludeSnapshot('full', undefined, params.filename);
  },
});

export const snapshotOptionsSchema = z.object({
  clientId: z.string().uuid().optional().describe('Persistent client identity for diff baseline continuity. Pass the clientId from your first tool response on all subsequent calls, including after resume.'),
  includeSnapshot: z.enum(['none', 'diff', 'full']).optional().describe('Control snapshot in response: "none" to suppress, "diff" for incremental diff, "full" for complete snapshot'),
  snapshotSelector: z.string().optional().describe('CSS selector to scope the snapshot to a DOM subtree (e.g. "main", ".content"). Only elements within the matched subtree appear in the snapshot. Refs from prior full-page snapshots remain valid.'),
  snapshotWaitFor: z.object({
    text: z.string().optional().describe('Wait for text to appear in page before snapshot'),
    textGone: z.string().optional().describe('Wait for text to disappear before snapshot'),
    selector: z.string().optional().describe('Wait for CSS selector to exist before snapshot'),
  }).optional().describe('Wait condition before capturing snapshot. Eliminates the need for a separate browser_wait_for + browser_snapshot sequence. Capped at configured timeout (default 3s).'),
  ...consoleOptionsSchema.shape,
});

export const elementSchema = z.object({
  element: z.string().optional().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().describe('Exact target element reference from the page snapshot'),
});

const clickSchema = elementSchema.extend({
  doubleClick: z.boolean().optional().describe('Whether to perform a double click instead of a single click'),
  button: z.enum(['left', 'right', 'middle']).optional().describe('Button to click, defaults to left'),
  modifiers: z.array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'])).optional().describe('Modifier keys to press'),
  ...snapshotOptionsSchema.shape,
});

const click = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_click',
    title: 'Click',
    description: 'Perform click on a web page. Returns a snapshot of the page after the action.',
    inputSchema: clickSchema,
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const { locator, resolved } = await tab.refLocator(params);
    const options = {
      button: params.button,
      modifiers: params.modifiers,
      ...tab.actionTimeoutOptions,
    };
    const optionsArg = formatObjectOrVoid(options);

    if (params.doubleClick)
      response.addCode(`await page.${resolved}.dblclick(${optionsArg});`);
    else
      response.addCode(`await page.${resolved}.click(${optionsArg});`);

    await tab.waitForCompletion(async () => {
      if (params.doubleClick)
        await locator.dblclick(options);
      else
        await locator.click(options);
    });
  },
});

const drag = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_drag',
    title: 'Drag mouse',
    description: 'Perform drag and drop between two elements. Returns a snapshot after drag.',
    inputSchema: z.object({
      startElement: z.string().describe('Human-readable source element description used to obtain the permission to interact with the element'),
      startRef: z.string().describe('Exact source element reference from the page snapshot'),
      endElement: z.string().describe('Human-readable target element description used to obtain the permission to interact with the element'),
      endRef: z.string().describe('Exact target element reference from the page snapshot'),
      ...snapshotOptionsSchema.shape,
    }),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const [start, end] = await tab.refLocators([
      { ref: params.startRef, element: params.startElement },
      { ref: params.endRef, element: params.endElement },
    ]);

    await tab.waitForCompletion(async () => {
      await start.locator.dragTo(end.locator, tab.actionTimeoutOptions);
    });

    response.addCode(`await page.${start.resolved}.dragTo(page.${end.resolved});`);
  },
});

const hover = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_hover',
    title: 'Hover mouse',
    description: 'Hover over element on page. Returns a snapshot after hover.',
    inputSchema: elementSchema.extend(snapshotOptionsSchema.shape),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const { locator, resolved } = await tab.refLocator(params);
    response.addCode(`await page.${resolved}.hover();`);

    await tab.waitForCompletion(async () => {
      await locator.hover(tab.actionTimeoutOptions);
    });
  },
});

const selectOptionSchema = elementSchema.extend({
  values: z.array(z.string()).describe('Array of values to select in the dropdown. This can be a single value or multiple values.'),
  ...snapshotOptionsSchema.shape,
});

const selectOption = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_select_option',
    title: 'Select option',
    description: 'Select an option in a dropdown. Returns a snapshot after selection.',
    inputSchema: selectOptionSchema,
    type: 'input',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const { locator, resolved } = await tab.refLocator(params);
    response.addCode(`await page.${resolved}.selectOption(${formatObject(params.values)});`);

    await tab.waitForCompletion(async () => {
      await locator.selectOption(params.values, tab.actionTimeoutOptions);
    });
  },
});

const pickLocator = defineTabTool({
  capability: 'testing',
  schema: {
    name: 'browser_generate_locator',
    title: 'Create locator for element',
    description: 'Generate locator for the given element to use in tests',
    inputSchema: elementSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const { resolved } = await tab.refLocator(params);
    response.addTextResult(resolved);
  },
});

const check = defineTabTool({
  capability: 'core-input',
  skillOnly: true,

  schema: {
    name: 'browser_check',
    title: 'Check',
    description: 'Check a checkbox or radio button',
    inputSchema: elementSchema,
    type: 'input',
  },

  handle: async (tab, params, response) => {
    const { locator, resolved } = await tab.refLocator(params);
    response.addCode(`await page.${resolved}.check();`);
    await locator.check(tab.actionTimeoutOptions);
  },
});

const uncheck = defineTabTool({
  capability: 'core-input',
  skillOnly: true,
  schema: {
    name: 'browser_uncheck',
    title: 'Uncheck',
    description: 'Uncheck a checkbox or radio button',
    inputSchema: elementSchema,
    type: 'input',
  },

  handle: async (tab, params, response) => {
    const { locator, resolved } = await tab.refLocator(params);
    response.addCode(`await page.${resolved}.uncheck();`);
    await locator.uncheck(tab.actionTimeoutOptions);
  },
});

export default [
  snapshot,
  click,
  drag,
  hover,
  selectOption,
  pickLocator,
  check,
  uncheck,
];
