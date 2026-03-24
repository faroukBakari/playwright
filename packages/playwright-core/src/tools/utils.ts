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

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const requests: playwright.Request[] = [];
  const perf = tab.context.perfLog;
  const perfConfig = tab.context.config.performance;

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

  const postActionDelay = perfConfig?.postActionDelay ?? 100;
  let result: R;
  try {
    result = await callback();
    await perf.timeAsync({
      phase: 'waitForCompletion', step: 'postActionDelay', side: 'chrome',
      target_ms: postActionDelay,
    }, () => tab.waitForTimeout(cappedTimeout(postActionDelay)));
  } finally {
    disposeListeners();
  }

  const requestedNavigation = requests.some(request => request.isNavigationRequest());
  if (requestedNavigation) {
    const navState = perfConfig?.navigationLoadState ?? 'domcontentloaded';
    const navTimeout = perfConfig?.navigationLoadTimeout ?? 5000;
    await perf.timeAsync({
      phase: 'waitForCompletion', step: 'navigationLoad', side: 'chrome',
      target_ms: navTimeout, state: navState,
    }, () => tab.page.mainFrame().waitForLoadState(navState, { timeout: cappedTimeout(navTimeout) }).catch(() => {}));
    return result;
  }

  const promises: Promise<any>[] = [];
  for (const request of requests) {
    if (['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(request.resourceType()))
      promises.push(request.response().then(r => r?.finished()).catch(() => {}));
    else
      promises.push(request.response().catch(() => {}));
  }
  const raceMs = perfConfig?.networkRaceTimeout ?? 3000;
  const raceTimeout = new Promise<void>(resolve => setTimeout(resolve, cappedTimeout(raceMs)));
  await perf.timeAsync({
    phase: 'waitForCompletion', step: 'networkRace', side: 'server',
    target_ms: raceMs, requests: requests.length,
  }, () => Promise.race([Promise.all(promises), raceTimeout]).then(() => {}));

  if (requests.length) {
    const postSettlementDelay = perfConfig?.postSettlementDelay ?? 10;
    await perf.timeAsync({
      phase: 'waitForCompletion', step: 'postSettlementDelay', side: 'chrome',
      target_ms: postSettlementDelay,
    }, () => tab.waitForTimeout(cappedTimeout(postSettlementDelay)));
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
