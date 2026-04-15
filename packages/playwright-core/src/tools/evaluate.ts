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

import path from 'path';

import { z } from '../mcpBundle';

import { validateFilename } from './response';
import { defineTabTool } from './tool';

import type { Tab } from './tab';

const evaluateSchema = z.object({
  function: z.string().describe('() => { /* code */ } or (element) => { /* code */ } when element is provided'),
  element: z.string().optional().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().optional().describe('Exact target element reference from the page snapshot'),
  filename: z.string().optional().describe('Filename to save the result to (written to /tmp/). If not provided, result is returned inline.'),
});

const evaluate = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_evaluate',
    title: 'Evaluate JavaScript',
    description: 'Evaluate JavaScript expression on page or element. Large results are automatically truncated.',
    inputSchema: evaluateSchema,
    type: 'action',
  },

  handle: async (tab, params, response) => {
    let locator: Awaited<ReturnType<Tab['refLocator']>> | undefined;
    if (!params.function.includes('=>'))
      params.function = `() => (${params.function})`;
    if (params.ref)
      locator = await tab.refLocator({ ref: params.ref, element: params.element || 'element' });

    const receiver = locator?.locator ?? tab.page;
    const result = await receiver._evaluateFunction(params.function);
    // For file output: raw strings stay raw (avoids double-encoding when the
    // function already returns JSON.stringify'd data). For inline: always
    // JSON.stringify for safe MCP text display.
    let text = params.filename && typeof result === 'string'
      ? result
      : (JSON.stringify(result, null, 2) || 'undefined');
    const maxLen = tab.context.config.evaluate?.maxResultLength;
    if (maxLen && text.length > maxLen)
      text = text.slice(0, maxLen) + `\n... [truncated: ${text.length} chars, limit ${maxLen}]`;
    if (params.filename) {
      validateFilename(params.filename);
      const filePath = path.join('/tmp', params.filename);
      await response.addFileResult(
          { fileName: filePath, relativeName: filePath, printableLink: `- [Result](${filePath})` },
          text
      );
      return;
    }
    response.addTextResult(text);
  },
});

export default [
  evaluate,
];
