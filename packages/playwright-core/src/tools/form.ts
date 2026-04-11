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
import { escapeWithQuotes } from '../utils/isomorphic/stringUtils';

import { defineTabTool } from './tool';
import { snapshotOptionsSchema } from './snapshot';

const fillForm = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_fill_form',
    title: 'Fill form',
    description: 'Fill multiple form fields. Returns a snapshot after filling. Optionally click a submit button after filling.',
    inputSchema: z.object({
      fields: z.array(z.object({
        name: z.string().describe('Human-readable field name'),
        type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider']).describe('Type of the field'),
        ref: z.string().describe('Exact target field reference from the page snapshot'),
        value: z.string().describe('Value to fill in the field. If the field is a checkbox, the value should be `true` or `false`. If the field is a combobox, the value should be the text of the option.'),
      })).describe('Fields to fill in'),
      submitRef: z.string().optional().describe('Ref of the submit button to click after filling all fields'),
      submitElement: z.string().optional().describe('Human-readable description of the submit button'),
      ...snapshotOptionsSchema.shape,
    }),
    type: 'input',
    minBudget: (rawArgs) => {
      const fieldCount = Array.isArray(rawArgs.fields) ? rawArgs.fields.length : 1;
      const hasSubmit = typeof rawArgs.submitRef === 'string';
      // Per-field: 800ms covers action + settle (P95 browser_type ~150ms with headroom)
      const fieldCost = fieldCount * 800;
      // Submit: click P95 (3001ms) + nav P95 (2132ms) + buffer = ~7000ms
      const submitCost = hasSubmit ? 7000 : 0;
      // Snapshot: SPA gate active after nav (1000ms margin) vs simple capture (500ms)
      const snapshotCost = hasSubmit ? 1500 : 500;
      return Math.max(5000, fieldCost + submitCost + snapshotCost);
    },
  },

  handle: async (tab, params, response) => {
    // Phase 1: Fill fields (waitForCompletion catches async validation, API calls)
    await tab.waitForCompletion(async () => {
      for (const field of params.fields) {
        const { locator, resolved } = await tab.refLocator({ element: field.name, ref: field.ref });
        const locatorSource = `await page.${resolved}`;
        if (field.type === 'textbox' || field.type === 'slider') {
          const secret = tab.context.lookupSecret(field.value);
          await locator.fill(secret.value, tab.actionTimeoutOptions);
          response.addCode(`${locatorSource}.fill(${secret.code});`);
        } else if (field.type === 'checkbox') {
          await locator.setChecked(field.value === 'true', tab.actionTimeoutOptions);
          response.addCode(`${locatorSource}.setChecked(${field.value});`);
        } else if (field.type === 'radio') {
          // Radio buttons cannot be unchecked via setChecked — use click() to select the target option.
          await locator.click(tab.actionTimeoutOptions);
          response.addCode(`${locatorSource}.click();`);
        } else if (field.type === 'combobox') {
          await locator.selectOption({ label: field.value }, tab.actionTimeoutOptions);
          response.addCode(`${locatorSource}.selectOption(${escapeWithQuotes(field.value)});`);
        }
      }
    });

    // Phase 2: Submit (optional — separate waitForCompletion for form submission settling)
    if (params.submitRef) {
      const { locator, resolved } = await tab.refLocator({
        element: params.submitElement ?? 'submit button',
        ref: params.submitRef,
      });
      response.addCode(`await page.${resolved}.click();`);
      await tab.waitForCompletion(async () => {
        await locator.click(tab.actionTimeoutOptions);
      });
    }

    response.setIncludeSnapshot();
  },
});

export default [
  fillForm,
];
