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

import { asLocator } from '../utils/isomorphic/locatorGenerators';
import { debug } from '../utilsBundle';

import type { Context } from './context';
import type { Page } from '../client/page';
import type { Locator } from '../client/locator';

const debugRefRecovery = debug('pw:mcp:ref-recovery');

export class RefResolver {
  private _context: Context;
  private _page: Page;
  private _refMetadata = new Map<string, { role: string, name: string }>();

  constructor(context: Context, page: Page) {
    this._context = context;
    this._page = page;
  }

  async refLocator(params: { element?: string, ref: string }): Promise<{ locator: Locator, resolved: string }> {
    try {
      return (await this.refLocators([params]))[0];
    } catch (firstError) {
      // Save stale ref metadata before re-snapshot clears it
      const staleRefMeta = this._refMetadata.get(params.ref);
      // Re-snapshot to refresh the element map (no event side effects)
      debugRefRecovery('stale ref=%s — re-snapshotting (meta: role=%s name=%s)', params.ref, staleRefMeta?.role, staleRefMeta?.name?.slice(0, 50));
      const interactableOnly = this._context.config.snapshot?.interactableOnly;
      const snapshot = await this._page._snapshotForAI({
        track: `response-${this._context.id}`,
        interactableOnly,
      });
      this.parseRefMetadata(snapshot.full);
      // Restore stale ref metadata for fallback (re-snapshot won't contain it)
      if (staleRefMeta)
        this._refMetadata.set(params.ref, staleRefMeta);
      try {
        const result = (await this.refLocators([params]))[0];
        debugRefRecovery('retry succeeded for ref=%s', params.ref);
        return result;
      } catch {
        debugRefRecovery('retry failed for ref=%s — trying role+name fallback', params.ref);
        return await this._refFallbackByRoleName(params, firstError as Error);
      }
    }
  }

  async refLocators(params: { element?: string, ref: string }[]): Promise<{ locator: Locator, resolved: string }[]> {
    return Promise.all(params.map(async param => {
      try {
        let locator = this._page.locator(`aria-ref=${param.ref}`);
        if (param.element)
          locator = locator.describe(param.element);
        const { resolvedSelector } = await locator._resolveSelector();
        return { locator, resolved: asLocator('javascript', resolvedSelector) };
      } catch (e) {
        const meta = this._refMetadata.get(param.ref);
        if (meta) {
          const desc = meta.name ? `${meta.role} '${meta.name}'` : meta.role;
          throw new Error(`ref ${param.ref} found — No element match for ${desc}. Try capturing new snapshot.`);
        }
        throw new Error(`Ref ${param.ref} not found in the current page snapshot. Try capturing new snapshot.`);
      }
    }));
  }

  parseRefMetadata(snapshotText: string) {
    // Do NOT clear — stale ref metadata must survive for the role+name fallback.
    // captureSnapshot() is called on every Response (even includeSnapshot:'none'),
    // so clearing would wipe metadata for refs that went stale between snapshots.
    // Snapshot format: "- role "name" [attr] [ref=eNN] [cursor=pointer]"
    // Name is JSON.stringify'd (double-quoted) or regex (/pattern/). Optional.
    // Attributes appear between name and [ref=...]. [ref=...] is always last before optional [cursor=pointer].
    const refPattern = /- (\w+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*(?:\[[^\]]*\]\s*)*\[ref=(\w+)\]/g;
    let match;
    while ((match = refPattern.exec(snapshotText)) !== null) {
      const [, role, name, ref] = match;
      this._refMetadata.set(ref, { role, name: name ?? '' });
    }
  }

  private async _refFallbackByRoleName(params: { element?: string, ref: string }, originalError: Error): Promise<{ locator: Locator, resolved: string }> {
    const meta = this._refMetadata.get(params.ref);
    if (!meta?.name) {
      debugRefRecovery('fallback skip: ref=%s has no name metadata', params.ref);
      throw originalError;
    }
    const locator = this._page.getByRole(meta.role as any, { name: meta.name, exact: true });
    const count = await locator.count();
    if (count !== 1) {
      debugRefRecovery('fallback skip: ref=%s role=%s name=%s matched %d elements (need exactly 1)', params.ref, meta.role, meta.name.slice(0, 50), count);
      throw originalError;
    }
    if (params.element)
      locator.describe(params.element);
    const { resolvedSelector } = await locator._resolveSelector();
    debugRefRecovery('fallback succeeded: ref=%s → role=%s name=%s', params.ref, meta.role, meta.name.slice(0, 50));
    return { locator, resolved: asLocator('javascript', resolvedSelector) };
  }
}
