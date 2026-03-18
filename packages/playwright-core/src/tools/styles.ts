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
import { defineTabTool } from './tool';

const stylesSchema = z.object({
  element: z.string().optional().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().describe('Exact target element reference from the page snapshot'),
  properties: z.array(z.string()).describe('CSS property names to retrieve (e.g. ["opacity", "display", "color", "pointer-events"])'),
});

const getStyles = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_get_styles',
    title: 'Get computed styles',
    description: 'Get computed CSS styles for an element. Returns a map of property names to their computed values. Useful for verifying visual state (opacity, display, visibility, color) without writing JavaScript.',
    inputSchema: stylesSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const { locator } = await tab.refLocator(params);
    const result = await locator.evaluate(
      (el: Element, props: string[]) => {
        const styles = window.getComputedStyle(el);
        const out: Record<string, string> = {};
        for (const p of props)
          out[p] = styles.getPropertyValue(p);
        return out;
      },
      params.properties
    );
    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

export default [getStyles];
