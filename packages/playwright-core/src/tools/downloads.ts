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
import { defineTool } from './tool';
import { relayHttpUrl } from '../mcp/extensionContextFactory';

const downloadFile = defineTool({
  capability: 'downloads',
  schema: {
    name: 'browser_download_file',
    title: 'Download file',
    description: 'Download a file from the given URL to Chrome\'s download directory. Returns the file path on completion.\n\nPREREQUISITE: Chrome\'s "Ask where to save each file" setting MUST be disabled (Chrome Settings > Downloads). If enabled, downloads will hang until timeout.\n\nThe file is saved to Chrome\'s default download directory. The returned path is a Windows path (e.g., C:\\Users\\...\\Downloads\\file.pdf). The caller is responsible for retrieving the file if needed.',
    inputSchema: z.object({
      url: z.string().describe('URL of the file to download'),
      filename: z.string().optional().describe('Suggested filename (relative to download directory). Chrome may modify it to avoid conflicts.'),
      timeout: z.coerce.number().optional().describe('Download timeout in seconds. Default: 30. Increase for large files.'),
    }),
    type: 'action',
  },

  handle: async (_context, params, response) => {
    if (!relayHttpUrl)
      throw new Error('Downloads require extension mode (Chrome bridge)');

    const timeoutMs = (params.timeout || 30) * 1000;
    const fetchResponse = await fetch(`${relayHttpUrl}/downloads/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: params.url,
        filename: params.filename,
        timeout: timeoutMs,
      }),
      signal: AbortSignal.timeout(timeoutMs + 10000),
    });

    if (!fetchResponse.ok) {
      const err = await fetchResponse.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `Download failed: HTTP ${fetchResponse.status}`);
    }

    const json = await fetchResponse.json();
    const data = json.result || json;
    response.addTextResult([
      `Download complete:`,
      `  File: ${data.filename}`,
      `  Size: ${data.fileSize} bytes`,
      `  MIME: ${data.mime || 'unknown'}`,
      `  URL: ${data.url}`,
    ].join('\n'));
  },
});

const downloadList = defineTool({
  capability: 'downloads',
  schema: {
    name: 'browser_download_list',
    title: 'List downloads',
    description: 'List recent downloads from Chrome\'s download history. Returns download ID, filename, state, size, and URL.',
    inputSchema: z.object({
      query: z.string().optional().describe('Search query to filter by URL or filename'),
      state: z.enum(['in_progress', 'interrupted', 'complete']).optional().describe('Filter by download state'),
      limit: z.number().optional().describe('Maximum number of results. Default: 20.'),
    }),
    type: 'readOnly',
  },

  handle: async (_context, params, response) => {
    if (!relayHttpUrl)
      throw new Error('Downloads require extension mode (Chrome bridge)');

    const fetchResponse = await fetch(`${relayHttpUrl}/downloads/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: params.query,
        state: params.state,
        limit: params.limit,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!fetchResponse.ok) {
      const err = await fetchResponse.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `Failed to list downloads: HTTP ${fetchResponse.status}`);
    }

    const json = await fetchResponse.json();
    const data = json.result || json;
    const downloads = data.downloads || [];

    if (downloads.length === 0) {
      response.addTextResult('No downloads found.');
      return;
    }

    const lines = downloads.map((d: any) =>
      `[${d.state}] ${d.filename || '(pending)'} (${d.fileSize} bytes) — ${d.url}`
    );
    response.addTextResult(lines.join('\n'));
  },
});

export default [downloadFile, downloadList];
