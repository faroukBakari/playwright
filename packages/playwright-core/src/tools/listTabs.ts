/**
 * browser_list_tabs — MCP tool for listing all Chrome tabs with automation state.
 *
 * Shows all browser tabs including which are attached to debugger sessions
 * and which are free. Uses extension relay for browser-side introspection.
 *
 * Only works in extension mode.
 */

import { z } from '../mcpBundle';
import { defineTool } from './tool';

interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
  debuggerAttached: boolean;
  attachedSessionId: string | null;
}

async function fetchTabs(relayUrl: string | undefined): Promise<TabInfo[]> {
  if (!relayUrl)
    throw new Error('browser_list_tabs requires extension mode (--extension flag).');
  const response = await fetch(`${relayUrl}/tabs`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Tab listing unavailable (HTTP ${response.status}): ${await response.text()}`);
  const data = await response.json();
  return data.tabs ?? [];
}

function formatTabsTable(tabs: TabInfo[], filter: string): string {
  const filtered = filter === 'automated'
    ? tabs.filter(t => t.debuggerAttached)
    : filter === 'free'
      ? tabs.filter(t => !t.debuggerAttached)
      : tabs;

  if (filtered.length === 0)
    return filter === 'all' ? 'No tabs found.' : `No ${filter} tabs found.`;

  const lines = [
    `### Browser Tabs (${filter})`,
    '',
    '| tabId | url | title | attached | sessionId |',
    '|-------|-----|-------|----------|-----------|',
  ];

  for (const t of filtered) {
    const attached = t.debuggerAttached ? '✓' : '';
    const session = t.attachedSessionId ?? '';
    const urlShort = t.url.length > 60 ? t.url.slice(0, 57) + '...' : t.url;
    const titleShort = t.title.length > 30 ? t.title.slice(0, 27) + '...' : t.title;
    lines.push(`| ${t.tabId} | ${urlShort} | ${titleShort} | ${attached} | ${session} |`);
  }

  lines.push('', `Total: ${filtered.length} tab(s)`);
  return lines.join('\n');
}

const listTabs = defineTool({
  capability: 'core-tabs',
  noTabRequired: true,

  schema: {
    name: 'browser_list_tabs',
    title: 'List browser tabs',
    description: 'List all browser tabs with automation state. Shows which tabs have an attached debugger session and which are free. Use filter to narrow results.',
    inputSchema: z.object({
      filter: z.enum(['all', 'automated', 'free']).default('all').describe('Filter tabs: "all" (default), "automated" (debugger attached), "free" (no debugger)'),
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const tabs = await fetchTabs(context.relayHttpUrl);
    const result = formatTabsTable(tabs, params.filter);
    response.addTextResult(result);
  },
});

export default [listTabs];
