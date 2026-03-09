/**
 * browser_select_tab — MCP tool for listing and targeting Chrome tabs
 * via the extension's tab registry (sideband HTTP on the CDP relay).
 *
 * Communication path:
 *   tool → HTTP GET /registry → relay → extension WS → chrome.storage
 *   tool → HTTP POST /registry/focus → relay → extension WS → chrome.tabs.update
 *
 * Only works in extension mode. Returns an error in headless/persistent modes.
 */

import { z } from '../mcpBundle';
import { defineTool } from './tool';
import { relayHttpUrl } from '../mcp/extensionContextFactory';

import type { Context } from './context';

interface RegistryTabEntry {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  status: string;
  debugger: {
    attached: boolean;
    lastAttached?: number;
    lastDetachReason?: string;
  };
  lastSeen: number;
}

async function fetchRegistry(): Promise<RegistryTabEntry[]> {
  if (!relayHttpUrl)
    throw new Error('Tab selection requires extension mode (--extension flag). Not available in headless or persistent browser modes.');
  const response = await fetch(`${relayHttpUrl}/registry`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Registry unavailable (HTTP ${response.status}): ${await response.text()}`);
  const data = await response.json();
  return data.tabs ?? [];
}

async function focusRegistryTab(tabId: number): Promise<void> {
  if (!relayHttpUrl)
    throw new Error('Tab focus requires extension mode.');
  const response = await fetch(`${relayHttpUrl}/registry/focus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Failed to focus tab ${tabId} (HTTP ${response.status}): ${await response.text()}`);
  const result = await response.json();
  if (!result.success)
    throw new Error(`Failed to focus tab ${tabId}: ${result.error}`);
}

function matchTab(tabs: RegistryTabEntry[], url?: string, tabId?: number): RegistryTabEntry | undefined {
  if (tabId !== undefined)
    return tabs.find(t => t.tabId === tabId);
  if (url) {
    // Try substring match first, then regex
    const substring = tabs.find(t => t.url.includes(url));
    if (substring)
      return substring;
    try {
      const re = new RegExp(url);
      return tabs.find(t => re.test(t.url));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function formatTabList(tabs: RegistryTabEntry[], currentTabId?: number): string {
  if (tabs.length === 0)
    return 'No tracked tabs in the registry. Navigate to a page first.';
  const lines = ['### Tracked Tabs (Extension Registry)', ''];
  for (const tab of tabs) {
    const debugIcon = tab.debugger.attached ? '🔗' : '⭘';
    const current = tab.tabId === currentTabId ? ' ← current' : '';
    lines.push(`- [${tab.tabId}] ${debugIcon} ${tab.title || '(untitled)'} — ${tab.url}${current}`);
  }
  return lines.join('\n');
}

const selectTab = defineTool({
  capability: 'core-tabs',

  schema: {
    name: 'browser_select_tab',
    title: 'Select Chrome tab',
    description: 'List tracked Chrome tabs or switch to a specific tab by URL pattern or tab ID. Requires extension mode.',
    inputSchema: z.object({
      url: z.string().optional().describe('URL pattern (substring or regex) to match a tab'),
      tabId: z.number().optional().describe('Exact Chrome tab ID to target'),
      mode: z.enum(['url', 'tabId', 'active', 'new', 'list']).optional().describe('Selection mode. Inferred from other params if omitted. "list" returns all tracked tabs.'),
    }),
    type: 'action',
  },

  handle: async (context: Context, params, response) => {
    // Infer mode from params
    let mode = params.mode;
    if (!mode) {
      if (params.url)
        mode = 'url';
      else if (params.tabId !== undefined)
        mode = 'tabId';
      else
        mode = 'list';
    }

    if (mode === 'list') {
      const tabs = await fetchRegistry();
      response.addTextResult(formatTabList(tabs));
      return;
    }

    if (mode === 'new') {
      const tab = await context.newTab();
      response.addTextResult(`Opened new tab.`);
      return;
    }

    if (mode === 'active') {
      const tabs = await fetchRegistry();
      // Find the most recently seen tab with debugger attached
      const active = tabs
        .filter(t => t.debugger.attached)
        .sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (!active) {
        response.addTextResult(formatTabList(tabs));
        return;
      }
      await focusRegistryTab(active.tabId);
      // Match to Context's _tabs by URL
      await syncTabToContext(context, active);
      response.addTextResult(`Focused tab [${active.tabId}]: ${active.title} — ${active.url}`);
      return;
    }

    // mode === 'url' or 'tabId'
    const tabs = await fetchRegistry();
    const matched = matchTab(tabs, params.url, params.tabId);
    if (!matched) {
      const hint = params.url ? `url pattern "${params.url}"` : `tabId ${params.tabId}`;
      response.addTextResult(`No tab matching ${hint}.\n\n${formatTabList(tabs)}`);
      return;
    }

    await focusRegistryTab(matched.tabId);
    await syncTabToContext(context, matched);
    response.addTextResult(`Focused tab [${matched.tabId}]: ${matched.title} — ${matched.url}`);
  },
});

/**
 * Sync a registry tab entry to Context's internal _tabs/_currentTab.
 * Finds the matching Playwright Page by URL and brings it to front.
 */
async function syncTabToContext(context: Context, entry: RegistryTabEntry): Promise<void> {
  await context.ensureBrowserContext();
  const tabs = context.tabs();
  // Find matching tab by URL
  const match = tabs.find(t => t.page.url() === entry.url)
    ?? tabs.find(t => t.page.url().includes(new URL(entry.url).hostname));
  if (match) {
    const index = tabs.indexOf(match);
    await context.selectTab(index);
  }
}

export default [selectTab];
