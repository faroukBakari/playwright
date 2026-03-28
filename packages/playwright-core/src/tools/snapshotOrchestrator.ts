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

import type { Context } from './context';
import type { Page } from '../client/page';
import type { ModalState } from './tool';
import type { EventEntry } from './artifactCollector';

export type TabSnapshot = {
  ariaSnapshot: string;
  ariaSnapshotDiff?: string;
  modalStates: ModalState[];
  events: EventEntry[];
  consoleLink?: string;
  selectorResolved?: boolean;
};

export type SnapshotCallbacks = {
  raceAgainstModalStates: (action: () => Promise<void>) => Promise<ModalState[]>;
  takeConsoleLog: (relativeTo: string | undefined) => Promise<string | undefined>;
  drainEvents: () => EventEntry[];
  updateRefMetadata: (snapshotText: string) => void;
};

export class SnapshotOrchestrator {
  private _context: Context;
  private _page: Page;
  private _needsFullSnapshot = false;

  constructor(context: Context, page: Page) {
    this._context = context;
    this._page = page;
  }

  get needsFullSnapshot(): boolean {
    return this._needsFullSnapshot;
  }

  set needsFullSnapshot(value: boolean) {
    this._needsFullSnapshot = value;
  }

  async captureSnapshot(relativeTo: string | undefined, options: { rootSelector?: string; clientId?: string } | undefined, callbacks: SnapshotCallbacks): Promise<TabSnapshot> {
    const interactableOnly = this._context.config.snapshot?.interactableOnly;
    const includeUrls = this._context.config.snapshot?.includeUrls;
    const settleMode = this._context.config.snapshot?.settleMode ?? 'quick';
    const gatesEnabled = this._context.config.snapshot?.gatesEnabled ?? true;
    const gateTimeoutMs = this._context.config.snapshot?.gateTimeoutMs ?? 2000;
    const rootSelector = options?.rootSelector;
    let tabSnapshot: TabSnapshot | undefined;
    const modalStates = await callbacks.raceAgainstModalStates(async () => {
      // Settle before snapshot: wait for framework re-renders to complete
      if (settleMode !== 'none') {
        const quietMs = this._context.config.snapshot?.settleQuietMs ?? 150;
        const settleResult = await this._page.evaluate(async ({ mode, quietMs, rootSelector, gatesEnabled, gateTimeoutMs }) => {
          const t0 = performance.now();
          const gateResults: Record<string, string> = { nav: 'skip', vt: 'skip', ariaBusy: 'skip' };

          if (gatesEnabled) {
            // Gate 1: Navigation API transition
            if (typeof (globalThis as any).navigation !== 'undefined' && (globalThis as any).navigation.transition) {
              gateResults.nav = 'active';
              await Promise.race([
                (globalThis as any).navigation.transition.finished.then(() => 'finished'),
                new Promise(r => setTimeout(() => r('timeout'), gateTimeoutMs)),
              ]);
              gateResults.nav = 'cleared';
            } else {
              gateResults.nav = 'inactive';
            }

            // Gate 2: View Transitions API
            try {
              if (document.documentElement.matches?.(':active-view-transition')) {
                gateResults.vt = 'active';
                await Promise.race([
                  new Promise<void>(resolve => {
                    const check = () => {
                      if (!document.documentElement.matches(':active-view-transition'))
                        return resolve();
                      requestAnimationFrame(check);
                    };
                    requestAnimationFrame(check);
                  }),
                  new Promise(r => setTimeout(() => r('timeout'), gateTimeoutMs)),
                ]);
                gateResults.vt = 'cleared';
              } else {
                gateResults.vt = 'inactive';
              }
            } catch {
              // :active-view-transition not supported in this browser
              gateResults.vt = 'unsupported';
            }

            // Gate 3: aria-busy
            if (document.querySelector('[aria-busy="true"]')) {
              gateResults.ariaBusy = 'active';
              await Promise.race([
                new Promise<void>(resolve => {
                  const mo = new MutationObserver(() => {
                    if (!document.querySelector('[aria-busy="true"]')) {
                      mo.disconnect(); resolve();
                    }
                  });
                  mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['aria-busy'] });
                }),
                new Promise(r => setTimeout(() => r('timeout'), gateTimeoutMs)),
              ]);
              gateResults.ariaBusy = 'cleared';
            } else {
              gateResults.ariaBusy = 'inactive';
            }
          }

          const gateMs = performance.now() - t0;

          // T1: drain microtask queue + double rAF
          await Promise.resolve();
          await new Promise<void>(r =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          );

          // T2: filtered MutationObserver quiescence
          if (mode === 'thorough') {
            let root: Element | null = null;
            if (rootSelector) {
              root = document.querySelector(rootSelector);
              if (!root) {
                for (const iframe of document.querySelectorAll('iframe')) {
                  try {
                    root = iframe.contentDocument?.querySelector(rootSelector) ?? null;
                    if (root) break;
                  } catch { /* cross-origin — skip */ }
                }
              }
            }
            if (!root) root = document.body;
            await new Promise<void>(resolve => {
              let quietTimer: ReturnType<typeof setTimeout>;
              const maxTimer = setTimeout(() => {
                observer.disconnect(); resolve();
              }, Math.max(quietMs * 4, 1000));
              const observer = new MutationObserver(mutations => {
                const meaningful = mutations.some(m => {
                  if (m.type === 'childList') {
                    for (const node of m.addedNodes) {
                      if (node.nodeType === 1) {
                        const tag = (node as Element).tagName;
                        if (tag !== 'SCRIPT' && tag !== 'STYLE'
                            && tag !== 'LINK' && tag !== 'IMG')
                          return true;
                      }
                    }
                    return m.removedNodes.length > 0;
                  }
                  if (m.type === 'attributes')
                    return !m.attributeName?.startsWith('data-analytics')
                        && !m.attributeName?.startsWith('data-track');
                  return true;
                });
                if (!meaningful) return;
                clearTimeout(quietTimer);
                quietTimer = setTimeout(() => {
                  observer.disconnect(); clearTimeout(maxTimer); resolve();
                }, quietMs);
              });
              observer.observe(root, {
                childList: true, subtree: true,
                attributes: true, characterData: true,
              });
              quietTimer = setTimeout(() => {
                observer.disconnect(); clearTimeout(maxTimer); resolve();
              }, quietMs);
            });
          }

          const settleMs = performance.now() - t0;
          return { gateMs, settleMs, gateResults };
        }, { mode: settleMode, quietMs, rootSelector, gatesEnabled, gateTimeoutMs });

        // Log gate telemetry server-side
        if (gatesEnabled && settleResult) {
          this._context.perfLog.timeAsync({
            phase: 'snapshot', step: 'settle-gates',
            side: 'chrome',
            target_ms: gateTimeoutMs,
            gate_nav: settleResult.gateResults.nav,
            gate_vt: settleResult.gateResults.vt,
            gate_aria_busy: settleResult.gateResults.ariaBusy,
            gate_ms: settleResult.gateMs,
            settle_ms: settleResult.settleMs,
            settle_mode: settleMode,
          }, async () => {});
        }
      }

      const snapshot = await this._context.perfLog.timeAsync({
        phase: 'snapshot', step: 'capture', side: 'chrome',
        target_ms: 8000,
        interactableOnly: !!interactableOnly,
        rootSelector: rootSelector || undefined,
      }, () => this._page._snapshotForAI({ track: `response-${options?.clientId ?? this._context.id}`, interactableOnly, includeUrls, rootSelector }), (result) => ({
        full_chars: result?.full.length ?? 0,
        diff_chars: result?.incremental?.length,
      }));
      tabSnapshot = {
        ariaSnapshot: snapshot.full,
        ariaSnapshotDiff: this._needsFullSnapshot ? undefined : snapshot.incremental,
        modalStates: [],
        events: [],
        selectorResolved: snapshot.selectorResolved,
      };
      callbacks.updateRefMetadata(snapshot.full);
    });
    if (tabSnapshot) {
      tabSnapshot.consoleLink = await callbacks.takeConsoleLog(relativeTo);
      tabSnapshot.events = callbacks.drainEvents();
    }

    // If we failed to capture a snapshot this time, make sure we do a full one next time,
    // to avoid reporting deltas against un-reported snapshot.
    this._needsFullSnapshot = !tabSnapshot;
    return tabSnapshot ?? {
      ariaSnapshot: '',
      ariaSnapshotDiff: '',
      modalStates,
      events: [],
    };
  }
}
