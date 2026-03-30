/**
 * Copyright 2019 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { helper } from './helper';
import { assert } from '../utils';
import { MultiMap } from '../utils/isomorphic/multimap';

// Plain .js — bypasses tsx/esbuild transforms so .toString() output is clean
// for cross-context evaluation in the browser page.
const { inPagePrepareForScreenshots } = require('./screenshotterInjected.js');

import type * as dom from './dom';
import type { Frame } from './frames';
import type { Page } from './page';
import type { Progress } from './progress';
import type * as types from './types';
import type { Rect } from '../utils/isomorphic/types';
import type { ParsedSelector } from '../utils/isomorphic/selectorParser';


declare global {
  interface Window {
    __pwCleanupScreenshot?: () => void;
  }
}

export type ScreenshotOptions = {
  type?: 'png' | 'jpeg';
  quality?: number;
  omitBackground?: boolean;
  animations?: 'disabled' | 'allow';
  mask?: { frame: Frame, selector: string}[];
  maskColor?: string;
  fullPage?: boolean;
  clip?: Rect;
  scale?: 'css' | 'device';
  caret?: 'hide' | 'initial';
  style?: string;
};

export class Screenshotter {
  private _queue = new TaskQueue();
  private _page: Page;

  constructor(page: Page) {
    this._page = page;
    this._queue = new TaskQueue();
  }

  private async _originalViewportSize(progress: Progress): Promise<types.Size> {
    let viewportSize = this._page.emulatedSize()?.viewport;
    if (!viewportSize)
      viewportSize = await this._page.mainFrame().waitForFunctionValueInUtility(progress, () => ({ width: window.innerWidth, height: window.innerHeight }));
    return viewportSize;
  }

  private async _fullPageSize(progress: Progress): Promise<types.Size> {
    const fullPageSize = await this._page.mainFrame().waitForFunctionValueInUtility(progress, () => {
      if (!document.body || !document.documentElement)
        return null;
      return {
        width: Math.max(
            document.body.scrollWidth, document.documentElement.scrollWidth,
            document.body.offsetWidth, document.documentElement.offsetWidth,
            document.body.clientWidth, document.documentElement.clientWidth
        ),
        height: Math.max(
            document.body.scrollHeight, document.documentElement.scrollHeight,
            document.body.offsetHeight, document.documentElement.offsetHeight,
            document.body.clientHeight, document.documentElement.clientHeight
        ),
      };
    });
    return fullPageSize!;
  }

  async screenshotPage(progress: Progress, options: ScreenshotOptions): Promise<Buffer> {
    const format = validateScreenshotOptions(options);
    return this._queue.postTask(async () => {
      progress.log('taking page screenshot');
      const viewportSize = await this._originalViewportSize(progress);
      await this._preparePageForScreenshot(progress, this._page.mainFrame(), options.style, options.caret !== 'initial', options.animations === 'disabled');
      try {
        if (options.fullPage) {
          const fullPageSize = await this._fullPageSize(progress);
          let documentRect = { x: 0, y: 0, width: fullPageSize.width, height: fullPageSize.height };
          const fitsViewport = fullPageSize.width <= viewportSize.width && fullPageSize.height <= viewportSize.height;
          if (options.clip)
            documentRect = trimClipToSize(options.clip, documentRect);
          return await this._screenshot(progress, format, documentRect, undefined, fitsViewport, options);
        }
        const viewportRect = options.clip ? trimClipToSize(options.clip, viewportSize) : { x: 0, y: 0, ...viewportSize };
        return await this._screenshot(progress, format, undefined, viewportRect, true, options);
      } finally {
        await this._restorePageAfterScreenshot();
      }
    });
  }

  async screenshotElement(progress: Progress, handle: dom.ElementHandle, options: ScreenshotOptions): Promise<Buffer> {
    const format = validateScreenshotOptions(options);
    return this._queue.postTask(async () => {
      progress.log('taking element screenshot');
      const viewportSize = await this._originalViewportSize(progress);

      await this._preparePageForScreenshot(progress, handle._frame, options.style, options.caret !== 'initial', options.animations === 'disabled');
      try {
        await handle._waitAndScrollIntoViewIfNeeded(progress, true /* waitForVisible */);

        const boundingBox = await progress.race(handle.boundingBox());
        assert(boundingBox, 'Node is either not visible or not an HTMLElement');
        assert(boundingBox.width !== 0, 'Node has 0 width.');
        assert(boundingBox.height !== 0, 'Node has 0 height.');

        const fitsViewport = boundingBox.width <= viewportSize.width && boundingBox.height <= viewportSize.height;
        const scrollOffset = await this._page.mainFrame().waitForFunctionValueInUtility(progress, () => ({ x: window.scrollX, y: window.scrollY }));
        const documentRect = { ...boundingBox };
        documentRect.x += scrollOffset.x;
        documentRect.y += scrollOffset.y;
        return await this._screenshot(progress, format, helper.enclosingIntRect(documentRect), undefined, fitsViewport, options);
      } finally {
        await this._restorePageAfterScreenshot();
      }
    });
  }

  async _preparePageForScreenshot(progress: Progress, frame: Frame, screenshotStyle: string | undefined, hideCaret: boolean, disableAnimations: boolean) {
    if (disableAnimations)
      progress.log('  disabled all CSS animations');
    const syncAnimations = this._page.delegate.shouldToggleStyleSheetToSyncAnimations();
    // TEMP DEBUG: verify .js import produces clean toString
    const fnSource = inPagePrepareForScreenshots.toString();
    if (fnSource.includes('__name'))
      console.error('[BUG] inPagePrepareForScreenshots.toString() still contains __name! First 200 chars:', fnSource.substring(0, 200));
    else
      console.error('[OK] inPagePrepareForScreenshots.toString() is clean (no __name). Length:', fnSource.length);
    await progress.race(this._page.safeNonStallingEvaluateInAllFrames('(' + fnSource + `)(${JSON.stringify(screenshotStyle)}, ${hideCaret}, ${disableAnimations}, ${syncAnimations})`, 'utility'));
    try {
      if (!process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY) {
        progress.log('waiting for fonts to load...');
        await progress.race(frame.nonStallingEvaluateInExistingContext('document.fonts.ready', 'utility').catch(() => {}));
        progress.log('fonts loaded');
      }
    } catch (error) {
      await this._restorePageAfterScreenshot();
      throw error;
    }
  }

  async _restorePageAfterScreenshot() {
    await this._page.safeNonStallingEvaluateInAllFrames('window.__pwCleanupScreenshot && window.__pwCleanupScreenshot()', 'utility');
  }

  async _maskElements(progress: Progress, options: ScreenshotOptions): Promise<() => Promise<void>> {
    if (!options.mask || !options.mask.length)
      return () => Promise.resolve();

    const framesToParsedSelectors: MultiMap<Frame, ParsedSelector> = new MultiMap();
    await progress.race(Promise.all((options.mask || []).map(async ({ frame, selector }) => {
      const pair = await frame.selectors.resolveFrameForSelector(selector);
      if (pair)
        framesToParsedSelectors.set(pair.frame, pair.info.parsed);
    })));

    const frames = [...framesToParsedSelectors.keys()];
    const cleanup = async () => {
      await Promise.all(frames.map(frame => frame.hideHighlight()));
    };

    try {
      const promises = frames.map(frame => frame.maskSelectors(framesToParsedSelectors.get(frame), options.maskColor || '#F0F'));
      await progress.race(Promise.all(promises));
      return cleanup;
    } catch (error) {
      cleanup().catch(() => {});
      throw error;
    }
  }

  private async _screenshot(progress: Progress, format: 'png' | 'jpeg', documentRect: types.Rect | undefined, viewportRect: types.Rect | undefined, fitsViewport: boolean, options: ScreenshotOptions): Promise<Buffer> {
    if ((options as any).__testHookBeforeScreenshot)
      await progress.race((options as any).__testHookBeforeScreenshot());

    const shouldSetDefaultBackground = options.omitBackground && format === 'png';
    if (shouldSetDefaultBackground)
      await progress.race(this._page.delegate.setBackgroundColor({ r: 0, g: 0, b: 0, a: 0 }));
    const cleanupHighlight = await this._maskElements(progress, options);

    try {
      const quality = format === 'jpeg' ? options.quality ?? 80 : undefined;
      const buffer = await this._page.delegate.takeScreenshot(progress, format, documentRect, viewportRect, quality, fitsViewport, options.scale || 'device');
      await cleanupHighlight();
      if (shouldSetDefaultBackground)
        await this._page.delegate.setBackgroundColor();
      if ((options as any).__testHookAfterScreenshot)
        await progress.race((options as any).__testHookAfterScreenshot());
      return buffer;
    } catch (error) {
      // Cleanup without blocking, it will be done before the next playwright action.
      cleanupHighlight().catch(() => {});
      if (shouldSetDefaultBackground)
        this._page.delegate.setBackgroundColor().catch(() => {});
      throw error;
    }
  }
}

class TaskQueue {
  private _chain: Promise<any>;

  constructor() {
    this._chain = Promise.resolve();
  }

  postTask(task: () => any): Promise<any> {
    const result = this._chain.then(task);
    this._chain = result.catch(() => {});
    return result;
  }
}

function trimClipToSize(clip: types.Rect, size: types.Size): types.Rect {
  const p1 = {
    x: Math.max(0, Math.min(clip.x, size.width)),
    y: Math.max(0, Math.min(clip.y, size.height))
  };
  const p2 = {
    x: Math.max(0, Math.min(clip.x + clip.width, size.width)),
    y: Math.max(0, Math.min(clip.y + clip.height, size.height))
  };
  const result = { x: p1.x, y: p1.y, width: p2.x - p1.x, height: p2.y - p1.y };
  assert(result.width && result.height, 'Clipped area is either empty or outside the resulting image');
  return result;
}

export function validateScreenshotOptions(options: ScreenshotOptions): 'png' | 'jpeg' {
  let format: 'png' | 'jpeg' | null = null;
  // options.type takes precedence over inferring the type from options.path
  // because it may be a 0-length file with no extension created beforehand (i.e. as a temp file).
  if (options.type) {
    assert(options.type === 'png' || options.type === 'jpeg', 'Unknown options.type value: ' + options.type);
    format = options.type;
  }

  if (!format)
    format = 'png';

  if (options.quality !== undefined) {
    assert(format === 'jpeg', 'options.quality is unsupported for the ' + format + ' screenshots');
    assert(typeof options.quality === 'number', 'Expected options.quality to be a number but found ' + (typeof options.quality));
    assert(Number.isInteger(options.quality), 'Expected options.quality to be an integer');
    assert(options.quality >= 0 && options.quality <= 100, 'Expected options.quality to be between 0 and 100 (inclusive), got ' + options.quality);
  }
  if (options.clip) {
    assert(typeof options.clip.x === 'number', 'Expected options.clip.x to be a number but found ' + (typeof options.clip.x));
    assert(typeof options.clip.y === 'number', 'Expected options.clip.y to be a number but found ' + (typeof options.clip.y));
    assert(typeof options.clip.width === 'number', 'Expected options.clip.width to be a number but found ' + (typeof options.clip.width));
    assert(typeof options.clip.height === 'number', 'Expected options.clip.height to be a number but found ' + (typeof options.clip.height));
    assert(options.clip.width !== 0, 'Expected options.clip.width not to be 0.');
    assert(options.clip.height !== 0, 'Expected options.clip.height not to be 0.');
  }
  return format;
}
