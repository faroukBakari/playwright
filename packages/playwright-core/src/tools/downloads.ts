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

import { z } from '../mcpBundle';
import { defineTabTool } from './tool';


export const downloadList = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_download_list',
    title: 'List downloads',
    description: 'List all downloads for the current session with their status and file paths',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const downloads = tab.downloads();
    if (!downloads.length) {
      response.addTextResult('No downloads in this session.');
      return;
    }
    const result = downloads.map((d, i) => ({
      index: i,
      filename: d.download.suggestedFilename(),
      url: d.download.url(),
      outputFile: d.outputFile,
      finished: d.finished,
      size: d.finished && fs.existsSync(d.outputFile) ? fs.statSync(d.outputFile).size : null,
    }));
    response.addTextResult(JSON.stringify(result, null, 2));
  },
});

export const downloadFile = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_download_file',
    title: 'Download a file',
    description: 'Navigate to a URL that triggers a file download, wait for it to complete, and return the file path',
    inputSchema: z.object({
      url: z.string().describe('The URL of the file to download'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    try {
      await tab.navigate(params.url);
    } catch (e: unknown) {
      // Navigation to a download URL throws "Download is starting" because
      // the browser interrupts the navigation to handle the file download.
      // This is expected — swallow it and check for the download below.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('Download is starting'))
        throw e;
    }

    const downloads = tab.downloads();
    const latest = downloads[downloads.length - 1];
    if (!latest) {
      response.addTextResult('Navigation completed but no download was triggered.');
      return;
    }

    if (!latest.finished)
      await latest.download.path();

    const size = fs.existsSync(latest.outputFile) ? fs.statSync(latest.outputFile).size : null;
    response.addTextResult(JSON.stringify({
      filename: latest.download.suggestedFilename(),
      outputFile: latest.outputFile,
      url: latest.download.url(),
      size,
      finished: true,
    }, null, 2));
  },
});

export default [
  downloadList,
  downloadFile,
];
