/**
 * browser_attach_tab — MCP tool for attaching this session to an existing tab.
 *
 * Enables tab reuse: agents can attach to pre-existing tabs instead of always
 * creating new ones. Implements last-attacher-wins: if another session owns the
 * tab, it gets bumped (detached) and this session takes over.
 *
 * Only works in extension mode.
 */

import { z } from '../mcpBundle';
import { serverLog } from '../mcp/log';
import { defineTool } from './tool';
import { waitForNewPage } from './tabUtils';
const attachTab = defineTool({
  capability: 'core-tabs',
  noTabRequired: true,

  schema: {
    name: 'browser_attach_tab',
    title: 'Attach to tab',
    description: 'Attach this session to an existing browser tab by tabId. If another session owns the tab, it gets detached (bumped). Use browser_list_tabs to find available tabIds.',
    inputSchema: z.object({
      tabId: z.number().describe('Chrome tab ID to attach to (from browser_list_tabs)'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    if (!context.relayHttpUrl)
      throw new Error('browser_attach_tab requires extension mode (--extension flag).');

    // Ensure BrowserContext exists so the 'page' event listener is registered.
    // Without this, CDP Target.attachedToTarget events are silently dropped
    // and the Page never materializes.
    await context.ensureBrowserContext();

    const fetchResponse = await fetch(`${context.relayHttpUrl}/tabs/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: context.id,
        tabId: params.tabId,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!fetchResponse.ok) {
      const text = await fetchResponse.text();
      throw new Error(`Failed to attach to tab ${params.tabId} (HTTP ${fetchResponse.status}): ${text}`);
    }

    const result = await fetchResponse.json();
    const expectedTargetId: string | undefined = result.targetInfo?.targetId;
    serverLog('lifecycle', `attachTab: relay success tabId=${params.tabId} targetId=${expectedTargetId ?? 'unknown'} sessionId=${context.id}`);

    // Wait for the Page to materialize via CDP event routing.
    const pagesBefore = new Set(context.tabs().map(t => t.page));
    await waitForNewPage(context, pagesBefore, 10000, `attachTab(tabId=${params.tabId})`);

    const lines = [`Attached to tab ${params.tabId}.`];
    if (result.targetInfo?.url)
      lines.push(`URL: ${result.targetInfo.url}`);
    if (result.targetInfo?.title)
      lines.push(`Title: ${result.targetInfo.title}`);
    if (result.bumpedSessionId)
      lines.push(`Previous session ${result.bumpedSessionId} was detached.`);

    response.setIncludeSnapshot();
    response.addTextResult(lines.join('\n'));
  },
});

export default [attachTab];
