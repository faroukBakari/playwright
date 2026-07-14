/**
 * Tests for browser latch reset on disconnection.
 *
 * The extension-mode browser promise latch (program.ts) must:
 * 1. Reset to null when the browser disconnects
 * 2. Create a new browser on next getOrCreateBrowser() call after reset
 * 3. Share the same promise for concurrent calls (latch pattern preserved)
 *
 * These tests exercise the latch pattern in isolation, using a fake
 * browser with an EventEmitter-style 'disconnected' event.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/** Fake browser with a 'disconnected' event, matching Playwright's Browser interface. */
class FakeBrowser extends EventEmitter {
  readonly id: string;
  constructor(id: string) {
    super();
    this.id = id;
  }
  contexts() {
    return [{}];
  }
}

describe('browser latch reset on disconnect', () => {
  let createCount: number;
  let fakeBrowsers: FakeBrowser[];
  let browserPromise: Promise<FakeBrowser> | null;

  /** Mimics getOrCreateBrowser from program.ts with the disconnect listener. */
  function getOrCreateBrowser(): Promise<FakeBrowser> {
    if (!browserPromise) {
      browserPromise = createBrowser().then(browser => {
        browser.on('disconnected', () => {
          browserPromise = null;
        });
        return browser;
      }).catch(e => {
        browserPromise = null;
        throw e;
      });
    }
    return browserPromise;
  }

  async function createBrowser(): Promise<FakeBrowser> {
    const browser = new FakeBrowser(`browser-${++createCount}`);
    fakeBrowsers.push(browser);
    return browser;
  }

  beforeEach(() => {
    createCount = 0;
    fakeBrowsers = [];
    browserPromise = null;
  });

  it('creates browser on first call', async () => {
    const browser = await getOrCreateBrowser();
    expect(browser.id).toBe('browser-1');
    expect(createCount).toBe(1);
  });

  it('returns same browser on subsequent calls (latch)', async () => {
    const b1 = await getOrCreateBrowser();
    const b2 = await getOrCreateBrowser();
    expect(b1).toBe(b2);
    expect(createCount).toBe(1);
  });

  it('resets latch on browser disconnect', async () => {
    const b1 = await getOrCreateBrowser();
    expect(b1.id).toBe('browser-1');

    // Simulate browser disconnect (CDP connection lost, extension grace expired)
    b1.emit('disconnected');

    // Latch should be reset — next call creates a new browser
    const b2 = await getOrCreateBrowser();
    expect(b2.id).toBe('browser-2');
    expect(createCount).toBe(2);
    expect(b2).not.toBe(b1);
  });

  it('concurrent calls after reset share the same new promise', async () => {
    const b1 = await getOrCreateBrowser();
    b1.emit('disconnected');

    // Multiple concurrent calls — all should get the same new browser
    const [b2a, b2b, b2c] = await Promise.all([
      getOrCreateBrowser(),
      getOrCreateBrowser(),
      getOrCreateBrowser(),
    ]);
    expect(b2a).toBe(b2b);
    expect(b2b).toBe(b2c);
    expect(b2a.id).toBe('browser-2');
    expect(createCount).toBe(2);
  });

  it('creation failure resets latch for retry', async () => {
    // Override createBrowser to fail once
    const originalCreate = createBrowser;
    let failOnce = true;
    const failingCreate = async (): Promise<FakeBrowser> => {
      if (failOnce) {
        failOnce = false;
        throw new Error('Chrome not reachable');
      }
      return originalCreate();
    };

    // Temporarily replace createBrowser reference via a wrapper
    let browserPromiseLocal: Promise<FakeBrowser> | null = null;
    const getOrCreate = () => {
      if (!browserPromiseLocal) {
        browserPromiseLocal = failingCreate().then(browser => {
          browser.on('disconnected', () => { browserPromiseLocal = null; });
          return browser;
        }).catch(e => {
          browserPromiseLocal = null;
          throw e;
        });
      }
      return browserPromiseLocal;
    };

    // First call fails
    await expect(getOrCreate()).rejects.toThrow('Chrome not reachable');

    // Second call succeeds (latch was reset on failure)
    const browser = await getOrCreate();
    expect(browser.id).toBe('browser-1');
  });

  it('multiple disconnect-reconnect cycles work', async () => {
    // Cycle 1
    const b1 = await getOrCreateBrowser();
    expect(b1.id).toBe('browser-1');
    b1.emit('disconnected');

    // Cycle 2
    const b2 = await getOrCreateBrowser();
    expect(b2.id).toBe('browser-2');
    b2.emit('disconnected');

    // Cycle 3
    const b3 = await getOrCreateBrowser();
    expect(b3.id).toBe('browser-3');
    expect(createCount).toBe(3);
  });
});
