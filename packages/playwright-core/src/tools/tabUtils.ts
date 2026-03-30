/**
 * Shared utilities for tab lifecycle tools (attachTab, createTab).
 */

import type { Context } from './context';
import type { Tab } from './tab';
import type { Page } from '../client/page';
import { serverLog } from '../mcp/log';

/**
 * Wait for a new Page to materialize via CDP event routing.
 * Polls at 100ms intervals, tracking by page object identity.
 *
 * @param context - MCP context with tabs()
 * @param pagesBefore - Set of Page objects that existed before the action
 * @param timeoutMs - Maximum time to wait
 * @param label - Log prefix for lifecycle messages (e.g. 'attachTab', 'createTab')
 * @returns The newly materialized Tab
 */
export async function waitForNewPage(
  context: Context, pagesBefore: Set<Page>, timeoutMs: number, label: string
): Promise<Tab> {
  serverLog('lifecycle', `${label}: waiting for new page, existing pages=${pagesBefore.size}`);

  const deadline = Date.now() + timeoutMs;
  let newTab = context.tabs().find(t => !pagesBefore.has(t.page));
  while (!newTab && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    newTab = context.tabs().find(t => !pagesBefore.has(t.page));
  }

  if (!newTab) {
    serverLog('warn', `${label}: page did not materialize — pagesBefore=${pagesBefore.size}, pagesNow=${context.tabs().length}`);
    throw new Error(`${label}: Playwright page did not materialize — CDP event routing may be broken for this session. Try restarting the server.`);
  }

  serverLog('lifecycle', `${label}: page materialized pagesNow=${context.tabs().length}`);
  return newTab;
}
