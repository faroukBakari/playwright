/**
 * browser_create_tab — MCP tool for explicit tab creation with debugger attachment.
 *
 * Creates a new browser tab and atomically attaches this session's debugger.
 * The agent can then navigate when ready. Create+attach is atomic to avoid
 * the friction of a separate follow-up call.
 *
 * Only works in extension mode.
 */

import { z } from '../mcpBundle';
import { defineTool } from './tool';
import { relayHttpUrl } from '../mcp/extensionContextFactory';

const createTab = defineTool({
  capability: 'core-tabs',

  schema: {
    name: 'browser_create_tab',
    title: 'Create tab',
    description: 'Create a new browser tab and attach this session to it. Optionally navigate to a URL. The tab is debugger-attached and ready for interaction.',
    inputSchema: z.object({
      url: z.string().optional().describe('URL to navigate to. Defaults to about:blank.'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    if (!relayHttpUrl)
      throw new Error('browser_create_tab requires extension mode (--extension flag).');

    const fetchResponse = await fetch(`${relayHttpUrl}/tabs/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: context.id,
        url: params.url,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!fetchResponse.ok) {
      const text = await fetchResponse.text();
      throw new Error(`Failed to create tab (HTTP ${fetchResponse.status}): ${text}`);
    }

    const result = await fetchResponse.json();
    response.addTextResult(`Created tab ${result.tabId}.\nURL: ${result.url}`);
  },
});

export default [createTab];
