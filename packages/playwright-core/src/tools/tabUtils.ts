/**
 * Shared utilities for tab lifecycle tools (attachTab, createTab).
 */

import { serverLog } from '../mcp/log';
import type { Context } from './context';
import type { Tab } from './tab';
import type { Page } from '../client/page';

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

const RECYCLE_TIMEOUT_MS = 10_000;

/**
 * Stop whatever still drives the session's page: the relay cycles the
 * debugger attachment on the same tab, which ends pending page commands,
 * and a new Page replaces the old one.
 */
export async function recycleTab(context: Context, label: string): Promise<Tab> {
  const pagesBefore = new Set(context.tabs().map(t => t.page));
  const fetchResponse = await fetch(`${context.relayHttpUrl}/tabs/recycle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: context.id }),
    signal: AbortSignal.timeout(RECYCLE_TIMEOUT_MS),
  });
  if (!fetchResponse.ok)
    throw new Error(`relay could not re-attach the tab (HTTP ${fetchResponse.status}): ${await fetchResponse.text()}`);
  return await waitForNewPage(context, pagesBefore, RECYCLE_TIMEOUT_MS, label);
}
