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

import type * as playwright from '../../types/types';
import type { Tab } from './tab';

// Hardcoded performance constants (consolidated from config — values stable since Wave 11)
const POST_ACTION_DELAY = 30;
const NAV_LOAD_STATE: 'domcontentloaded' = 'domcontentloaded';
const NAV_LOAD_TIMEOUT = 5000;
const NETWORK_RACE_TIMEOUT = 3000;
const POST_SETTLEMENT_DELAY = 10;

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const requests: playwright.Request[] = [];
  const perf = tab.context.perfLog;

  const cappedTimeout = (configured: number): number => {
    const remaining = tab.context.remainingBudget();
    if (remaining === Infinity)
      return configured;
    return Math.min(configured, Math.max(0, remaining));
  };

  const requestListener = (request: playwright.Request) => requests.push(request);
  const disposeListeners = () => {
    tab.page.off('request', requestListener);
  };
  tab.page.on('request', requestListener);

  let result: R;
  try {
    result = await callback();
    await perf.timeAsync({
      phase: 'waitForCompletion', step: 'postActionDelay', side: 'chrome',
      target_ms: POST_ACTION_DELAY,
    }, () => tab.waitForTimeout(cappedTimeout(POST_ACTION_DELAY)));
  } finally {
    disposeListeners();
  }

  const requestedNavigation = requests.some(request => request.isNavigationRequest());
  if (requestedNavigation) {
    await perf.timeAsync({
      phase: 'waitForCompletion', step: 'navigationLoad', side: 'chrome',
      target_ms: NAV_LOAD_TIMEOUT, state: NAV_LOAD_STATE,
    }, () => tab.page.mainFrame().waitForLoadState(NAV_LOAD_STATE, { timeout: cappedTimeout(NAV_LOAD_TIMEOUT) }).catch(() => {}));
    return result;
  }

  const promises: Promise<any>[] = [];
  for (const request of requests) {
    if (['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(request.resourceType()))
      promises.push(request.response().then(r => r?.finished()).catch(() => {}));
    else
      promises.push(request.response().catch(() => {}));
  }
  const raceTimeout = new Promise<void>(resolve => setTimeout(resolve, cappedTimeout(NETWORK_RACE_TIMEOUT)));
  await perf.timeAsync({
    phase: 'waitForCompletion', step: 'networkRace', side: 'server',
    target_ms: NETWORK_RACE_TIMEOUT, requests: requests.length,
  }, () => Promise.race([Promise.all(promises), raceTimeout]).then(() => {}));

  if (requests.length) {
    await perf.timeAsync({
      phase: 'waitForCompletion', step: 'postSettlementDelay', side: 'chrome',
      target_ms: POST_SETTLEMENT_DELAY,
    }, () => tab.waitForTimeout(cappedTimeout(POST_SETTLEMENT_DELAY)));
  }

  return result;
}

export async function callOnPageNoTrace<T>(page: playwright.Page, callback: (page: playwright.Page) => Promise<T>): Promise<T> {
  return await (page as any)._wrapApiCall(() => callback(page), { internal: true });
}

export function eventWaiter<T>(page: playwright.Page, event: string, timeout: number): { promise: Promise<T | undefined>, abort: () => void } {
  const disposables: (() => void)[] = [];

  const eventPromise = new Promise<T | undefined>((resolve, reject) => {
    page.on(event as any, resolve as any);
    disposables.push(() => page.off(event as any, resolve as any));
  });

  let abort: () => void;
  const abortPromise = new Promise<T | undefined>((resolve, reject) => {
    abort = () => resolve(undefined);
  });

  const timeoutPromise = new Promise<T | undefined>(f => {
    const timeoutId = setTimeout(() => f(undefined), timeout);
    disposables.push(() => clearTimeout(timeoutId));
  });

  return {
    promise: Promise.race([eventPromise, abortPromise, timeoutPromise]).finally(() => disposables.forEach(dispose => dispose())),
    abort: abort!
  };
}
