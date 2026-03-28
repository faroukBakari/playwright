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
    if (!context.relayHttpUrl)
      throw new Error('browser_create_tab requires extension mode (--extension flag).');

    // Ensure BrowserContext exists so the 'page' event listener is registered.
    // Without this, CDP Target.attachedToTarget events are silently dropped
    // and the Page never materializes.
    await context.ensureBrowserContext();

    const tabCountBefore = context.tabs().length;

    const fetchResponse = await fetch(`${context.relayHttpUrl}/tabs/create`, {
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

    // Wait for the Page to materialize via CDP event routing.
    const deadline = Date.now() + 10000;
    while (context.tabs().length <= tabCountBefore && Date.now() < deadline)
      await new Promise(r => setTimeout(r, 100));

    if (context.tabs().length <= tabCountBefore)
      throw new Error(`Tab ${result.tabId} created but Playwright page did not materialize — CDP event routing may be broken for this session. Try restarting the server.`);

    response.addTextResult(`Created tab ${result.tabId}.\nURL: ${result.url}`);
  },
});

export default [createTab];
