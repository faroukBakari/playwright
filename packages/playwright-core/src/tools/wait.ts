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
import { debug } from '../utilsBundle';
import { defineTool } from './tool';
import { snapshotOptionsSchema } from './snapshot';

import type { Response } from './response';
import type { Tab } from './tab';

const waitDebug = debug('pw:mcp:wait');

type WaitParams = {
  time?: number;
  text?: string;
  textGone?: string;
  url?: string;
  selector?: string;
  selectorState?: 'visible' | 'hidden' | 'attached' | 'detached';
  function?: string;
  networkIdle?: boolean;
  timeout?: number;
};

type Outcome = 'hit' | 'timeout' | 'error';

// Hardcoded wait constants (consolidated from config — values stable since Wave 11)
const WAIT_DEFAULT_TIMEOUT = 3000;
const WAIT_MAX_TIMEOUT = 30000;
const WAIT_FAST_POLL_INTERVAL = 200;
const WAIT_FAST_POLL_RETRIES = 5;

function resolveTimeout(_tab: Tab, params: WaitParams): number {
  const resolved = params.timeout
    ? Math.min(params.timeout * 1000, WAIT_MAX_TIMEOUT)
    : WAIT_DEFAULT_TIMEOUT;
  waitDebug('resolveTimeout: default=%d max=%d requested=%s resolved=%d',
      WAIT_DEFAULT_TIMEOUT, WAIT_MAX_TIMEOUT, params.timeout ?? 'none', resolved);
  return resolved;
}

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && e.name === 'TimeoutError';
}

async function handleTime(tab: Tab, params: WaitParams, response: Response, _timeoutMs: number): Promise<Outcome> {
  const ms = Math.min(WAIT_MAX_TIMEOUT, params.time! * 1000);
  waitDebug('time: waiting %ds (%dms, max %dms)', params.time, ms, WAIT_MAX_TIMEOUT);
  const perf = tab.context.perfLog;
  response.addCode(`await new Promise(f => setTimeout(f, ${params.time!} * 1000));`);
  await perf.timeAsync({
    phase: 'wait', step: 'time', side: 'server',
    target_ms: ms, condition: 'time', value: String(params.time),
  }, () => new Promise(f => setTimeout(f, ms)));
  waitDebug('time: done');
  response.addTextResult(`Waited ${params.time} seconds`);
  // Respect explicit includeSnapshot param even for time-only waits
  if ((params as any).includeSnapshot)
    response.setIncludeSnapshot();
  return 'hit';
}

async function handleText(tab: Tab, params: WaitParams, response: Response, timeoutMs: number): Promise<Outcome> {
  const perf = tab.context.perfLog;
  const text = params.text!;

  waitDebug('text: searching for "%s" (fastPoll: %dx%dms, locatorTimeout: %dms)',
      text, WAIT_FAST_POLL_RETRIES, WAIT_FAST_POLL_INTERVAL, timeoutMs);

  // Stage 1: Fast-poll via page.evaluate (avoids locator overhead)
  let found = false;
  try {
    found = await perf.timeAsync({
      phase: 'wait', step: 'textFastPoll', side: 'chrome',
      target_ms: WAIT_FAST_POLL_INTERVAL * WAIT_FAST_POLL_RETRIES,
      condition: 'text', value: text,
    }, async () => {
      for (let i = 0; i < WAIT_FAST_POLL_RETRIES; i++) {
        const visible = await tab.page.evaluate((t: string) => document.body?.innerText?.includes(t), text);
        if (visible) {
          waitDebug('text: fast-poll hit on retry %d/%d', i + 1, WAIT_FAST_POLL_RETRIES);
          return true;
        }
        if (i < WAIT_FAST_POLL_RETRIES - 1)
          await new Promise(f => setTimeout(f, WAIT_FAST_POLL_INTERVAL));
      }
      waitDebug('text: fast-poll exhausted %d retries', WAIT_FAST_POLL_RETRIES);
      return false;
    });
  } catch (e) {
    waitDebug('text: fast-poll error (context destroyed?): %s', e);
    // Navigation context destroyed — fall through to locator
  }

  // Stage 2: Locator with visibility filter (only if fast-poll missed)
  if (!found) {
    const remaining = Math.max(timeoutMs - (WAIT_FAST_POLL_INTERVAL * WAIT_FAST_POLL_RETRIES), 500);
    waitDebug('text: falling back to locator (remaining: %dms)', remaining);
    try {
      await perf.timeAsync({
        phase: 'wait', step: 'textLocator', side: 'server',
        target_ms: remaining,
        condition: 'text', value: text,
      }, () => tab.page.getByText(text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: remaining }));
      found = true;
      waitDebug('text: locator hit');
    } catch (e) {
      if (!isTimeoutError(e))
        throw e;
      waitDebug('text: locator timed out after %dms', remaining);
    }
  }

  const outcome: Outcome = found ? 'hit' : 'timeout';
  waitDebug('text: outcome=%s for "%s"', outcome, text);

  if (found)
    response.addTextResult(`Text "${text}" appeared on page`);
  else
    response.addTextResult(`Timed out waiting for text "${text}", returning current page state`);
  response.setIncludeSnapshot();
  return outcome;
}

async function handleTextGone(tab: Tab, params: WaitParams, response: Response, timeoutMs: number): Promise<Outcome> {
  const perf = tab.context.perfLog;
  const text = params.textGone!;

  waitDebug('textGone: waiting for "%s" to disappear (timeout: %dms)', text, timeoutMs);

  try {
    await perf.timeAsync({
      phase: 'wait', step: 'textGoneLocator', side: 'server',
      target_ms: timeoutMs,
      condition: 'textGone', value: text,
    }, () => tab.page.getByText(text).filter({ visible: true }).first().waitFor({ state: 'hidden', timeout: timeoutMs }));
    waitDebug('textGone: text disappeared');
    response.addTextResult(`Text "${text}" disappeared from page`);
    response.setIncludeSnapshot();
    return 'hit';
  } catch (e) {
    if (!isTimeoutError(e))
      throw e;
    waitDebug('textGone: timed out after %dms', timeoutMs);
    response.addTextResult(`Timed out waiting for text "${text}" to disappear, returning current page state`);
    response.setIncludeSnapshot();
    return 'timeout';
  }
}

async function handleUrl(tab: Tab, params: WaitParams, response: Response, timeoutMs: number): Promise<Outcome> {
  const perf = tab.context.perfLog;
  const pattern = params.url!;

  waitDebug('url: waiting for pattern "%s" (timeout: %dms)', pattern, timeoutMs);

  try {
    await perf.timeAsync({
      phase: 'wait', step: 'urlWait', side: 'server',
      target_ms: timeoutMs,
      condition: 'url', value: pattern,
    }, () => tab.page.waitForURL(pattern, { timeout: timeoutMs }));
    waitDebug('url: matched pattern "%s"', pattern);
    response.addTextResult(`URL matched pattern "${pattern}"`);
    response.setIncludeSnapshot();
    return 'hit';
  } catch (e) {
    if (!isTimeoutError(e))
      throw e;
    waitDebug('url: timed out after %dms for pattern "%s"', timeoutMs, pattern);
    response.addTextResult(`Timed out waiting for URL "${pattern}", returning current page state`);
    response.setIncludeSnapshot();
    return 'timeout';
  }
}

async function handleSelector(tab: Tab, params: WaitParams, response: Response, timeoutMs: number): Promise<Outcome> {
  const perf = tab.context.perfLog;
  const sel = params.selector!;
  const state = params.selectorState ?? 'visible';

  waitDebug('selector: waiting for "%s" state="%s" (timeout: %dms)', sel, state, timeoutMs);

  try {
    await perf.timeAsync({
      phase: 'wait', step: 'selectorWait', side: 'server',
      target_ms: timeoutMs,
      condition: 'selector', value: sel, state,
    }, () => tab.page.waitForSelector(sel, { state, timeout: timeoutMs }));
    waitDebug('selector: "%s" reached state="%s"', sel, state);
    response.addTextResult(`Selector "${sel}" reached state "${state}"`);
    response.setIncludeSnapshot();
    return 'hit';
  } catch (e) {
    if (!isTimeoutError(e))
      throw e;
    waitDebug('selector: timed out after %dms for "%s" state="%s"', timeoutMs, sel, state);
    response.addTextResult(`Timed out waiting for selector "${sel}" state "${state}", returning current page state`);
    response.setIncludeSnapshot();
    return 'timeout';
  }
}

async function handleFunction(tab: Tab, params: WaitParams, response: Response, timeoutMs: number): Promise<Outcome> {
  const perf = tab.context.perfLog;
  const fn = params.function!;

  waitDebug('function: evaluating (timeout: %dms) fn=%s', timeoutMs, fn.substring(0, 100));

  try {
    await perf.timeAsync({
      phase: 'wait', step: 'functionWait', side: 'chrome',
      target_ms: timeoutMs,
      condition: 'function', value: fn.substring(0, 200),
    }, () => tab.page.waitForFunction(fn, undefined, { timeout: timeoutMs }));
    waitDebug('function: condition satisfied');
    response.addTextResult(`Function condition satisfied`);
    response.setIncludeSnapshot();
    return 'hit';
  } catch (e) {
    if (!isTimeoutError(e))
      throw e;
    waitDebug('function: timed out after %dms', timeoutMs);
    response.addTextResult(`Timed out waiting for function condition, returning current page state`);
    response.setIncludeSnapshot();
    return 'timeout';
  }
}

async function handleNetworkIdle(tab: Tab, _params: WaitParams, response: Response, timeoutMs: number): Promise<Outcome> {
  const perf = tab.context.perfLog;
  let timer: ReturnType<typeof setTimeout>;

  waitDebug('networkIdle: waiting (timeout: %dms)', timeoutMs);

  const result = await perf.timeAsync({
    phase: 'wait', step: 'networkIdle', side: 'chrome',
    target_ms: timeoutMs,
    condition: 'networkIdle', value: 'true',
  }, () => Promise.race([
    tab.page.waitForLoadState('networkidle').then(() => 'idle' as const),
    new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]), r => ({ raceResult: r }));

  clearTimeout(timer!);

  if (result === 'timeout') {
    waitDebug('networkIdle: timed out after %dms', timeoutMs);
    response.addTextResult(`Timed out waiting for network idle (analytics-heavy sites may prevent this)`);
    // No snapshot for networkIdle — pure timing signal
    return 'timeout';
  }
  waitDebug('networkIdle: reached idle state');
  response.addTextResult(`Network reached idle state`);
  // No snapshot for networkIdle — pure timing signal
  return 'hit';
}

type Handler = (tab: Tab, params: WaitParams, response: Response, timeoutMs: number) => Promise<Outcome>;

const handlers: Record<string, Handler> = {
  time: handleTime,
  text: handleText,
  textGone: handleTextGone,
  url: handleUrl,
  selector: handleSelector,
  function: handleFunction,
  networkIdle: handleNetworkIdle,
};

const wait = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_wait_for',
    title: 'Wait for',
    description: `Wait for a page condition. Supports multiple condition types:
- text/textGone: Wait for visible text to appear or disappear (fastest for content checks)
- url: Wait for URL to match a glob pattern (e.g. "**/dashboard") — use after clicks that trigger navigation
- selector: Wait for a CSS selector state (visible/hidden/attached/detached)
- function: Evaluate a JavaScript expression until truthy — last resort for complex conditions
- networkIdle: Wait until no network requests for 500ms — use after actions that trigger API calls
- time: Fixed delay in seconds — last resort, prefer condition-based waits

Only one condition type per call. Default timeout 3s, override with timeout param (max configurable via waitMaxTimeout).
On timeout, returns current page state — you decide the next step.`,
    inputSchema: z.object({
      time: z.number().optional().describe('Fixed delay in seconds (last resort — prefer condition-based waits)'),
      text: z.string().optional().describe('Text to wait for on the visible page'),
      textGone: z.string().optional().describe('Text to wait for to disappear from the visible page'),
      url: z.string().optional().describe('URL glob pattern to wait for (e.g. "**/dashboard")'),
      selector: z.string().optional().describe('CSS selector to wait for'),
      selectorState: z.enum(['visible', 'hidden', 'attached', 'detached']).optional()
          .describe('Selector state to wait for (default: visible)'),
      function: z.string().optional()
          .describe('JavaScript expression evaluated in browser. Must return truthy when done. Last resort — prefer text or selector.'),
      networkIdle: z.boolean().optional()
          .describe('Wait until no network requests for 500ms. May hang on analytics-heavy sites.'),
      timeout: z.coerce.number().optional().describe('Override timeout in seconds (default 3, max configurable via waitMaxTimeout)'),
      ...snapshotOptionsSchema.shape,
    }),
    type: 'assertion',
  },

  handle: async (context, params, response) => {
    const conditionKeys = Object.keys(handlers).filter(k => (params as any)[k] !== undefined);
    if (conditionKeys.length === 0)
      throw new Error('At least one condition must be provided: time, text, textGone, url, selector, function, or networkIdle');
    if (conditionKeys.length > 1)
      throw new Error(`Only one condition type per call, got: ${conditionKeys.join(', ')}`);

    const conditionName = conditionKeys[0];
    const handler = handlers[conditionName];
    waitDebug('handle: condition=%s params=%o', conditionName, params);

    const tab = context.currentTabOrDie();
    const timeoutMs = params.time !== undefined ? 0 : resolveTimeout(tab, params);
    const perf = tab.context.perfLog;
    const conditionValue = String((params as any)[conditionName]).substring(0, 200);

    // End-to-end timing with outcome captured via extras callback.
    // On success: extras receives the Outcome from the handler.
    // On error: extras receives undefined result + the error, records 'error'.
    await perf.timeAsync({
      phase: 'wait', step: 'e2e', side: 'server',
      target_ms: timeoutMs || (params.time! * 1000),
      condition: conditionName, value: conditionValue,
    }, () => handler(tab, params, response, timeoutMs),
    (result, error) => ({ outcome: error ? 'error' : result }));
    waitDebug('handle: done condition=%s', conditionName);
  },
});

export { resolveTimeout, handleText, handleSelector, handleUrl };

export default [
  wait,
];
