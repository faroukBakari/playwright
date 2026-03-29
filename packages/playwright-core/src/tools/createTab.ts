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
import { serverLog } from '../mcp/log';
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
    const expectedTargetId: string | undefined = result.targetInfo?.targetId;
    serverLog('lifecycle', `createTab: relay success tabId=${result.tabId} targetId=${expectedTargetId ?? 'unknown'} sessionId=${context.id}`);

    // Wait for the Page to materialize via CDP event routing.
    // Track by page object identity — count-based detection fails when a stale
    // target is cleaned up (count drops then returns to original on replacement).
    const pagesBefore = new Set(context.tabs().map(t => t.page));
    serverLog('lifecycle', `createTab: waiting for new page, existing pages=${pagesBefore.size}`);

    const deadline = Date.now() + 10000;
    let newTab = context.tabs().find(t => !pagesBefore.has(t.page));
    while (!newTab && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      newTab = context.tabs().find(t => !pagesBefore.has(t.page));
    }

    if (!newTab) {
      serverLog('warn', `createTab: page did not materialize — targetId=${expectedTargetId}, pagesBefore=${pagesBefore.size}, pagesNow=${context.tabs().length}`);
      throw new Error(`Tab ${result.tabId} created but Playwright page did not materialize (targetId=${expectedTargetId}) — CDP event routing may be broken for this session. Try restarting the server.`);
    }

    serverLog('lifecycle', `createTab: page materialized tabId=${result.tabId} targetId=${expectedTargetId} pagesNow=${context.tabs().length}`);

    response.setIncludeSnapshot();
    response.addTextResult(`Created tab ${result.tabId}.\nURL: ${result.url}`);
  },
});

export default [createTab];
