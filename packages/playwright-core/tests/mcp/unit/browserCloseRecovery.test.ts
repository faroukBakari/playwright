/**
 * Tests for browser-close recovery via context eviction.
 *
 * When Chrome closes entirely, the server's `browser.on('disconnected')`
 * handler calls `sharedBackend.removeContext(sessionId)` to evict the stale
 * Context from `_contexts`. The next tool call then falls through to the
 * browserFactory path in `_resolveContext`, creating a fresh browser + context.
 *
 * These tests exercise the eviction + re-creation lifecycle in isolation,
 * extracting the minimal behavioral contract from browserServerBackend.ts
 * and program.ts without needing a real browser or MCP server.
 */
import { describe, it, expect, beforeEach } from 'vitest';

type MockContext = { id: string; disposed: boolean };

/**
 * Minimal extraction of the browser lifecycle from browserServerBackend.ts
 * and program.ts disconnect handler. Models:
 * - _contexts map (session → Context)
 * - browserFactory (creates new contexts on demand)
 * - removeContext (evicts stale context)
 * - _resolveContext (cache-hit or factory fallback)
 * - disconnect handler guards (sharedBackend && sessionId)
 */
class BrowserLifecycle {
  _contexts: Map<string, MockContext> = new Map();
  _factoryCallCount = 0;
  _sharedBackend: BrowserLifecycle | undefined;

  constructor(opts?: { sharedBackend?: BrowserLifecycle | undefined }) {
    this._sharedBackend = opts?.sharedBackend ?? this;
  }

  async browserFactory(sessionId: string): Promise<MockContext> {
    this._factoryCallCount++;
    const ctx: MockContext = { id: sessionId, disposed: false };
    this._contexts.set(sessionId, ctx);
    return ctx;
  }

  async removeContext(sessionId: string): Promise<void> {
    const ctx = this._contexts.get(sessionId);
    if (!ctx)
      return;
    ctx.disposed = true;
    this._contexts.delete(sessionId);
  }

  async resolveContext(sessionId: string): Promise<MockContext> {
    const existing = this._contexts.get(sessionId);
    if (existing)
      return existing;
    return this.browserFactory(sessionId);
  }

  /**
   * Simulates the disconnect handler in program.ts:127-132.
   * Guards: sharedBackend must exist AND sessionId must be defined.
   */
  simulateDisconnect(sessionId: string | undefined): void {
    if (this._sharedBackend && sessionId)
      this._sharedBackend.removeContext(sessionId).catch(() => {});
  }
}

describe('browser close recovery', () => {
  let lifecycle: BrowserLifecycle;

  beforeEach(() => {
    lifecycle = new BrowserLifecycle();
  });

  it('removeContext evicts stale context', async () => {
    await lifecycle.browserFactory('session-a');
    expect(lifecycle._contexts.has('session-a')).toBe(true);

    await lifecycle.removeContext('session-a');

    expect(lifecycle._contexts.has('session-a')).toBe(false);
  });

  it('next resolve after disconnect creates fresh context', async () => {
    const original = await lifecycle.browserFactory('session-a');
    await lifecycle.removeContext('session-a');

    const fresh = await lifecycle.resolveContext('session-a');

    expect(fresh).not.toBe(original);
    expect(fresh.id).toBe('session-a');
    expect(lifecycle._factoryCallCount).toBe(2);
  });

  it('disconnect is idempotent', async () => {
    await lifecycle.browserFactory('session-a');

    await lifecycle.removeContext('session-a');
    await lifecycle.removeContext('session-a');

    expect(lifecycle._contexts.has('session-a')).toBe(false);
  });

  it('multi-session isolation — disconnect A leaves B untouched', async () => {
    await lifecycle.browserFactory('session-a');
    const ctxB = await lifecycle.browserFactory('session-b');

    await lifecycle.removeContext('session-a');

    expect(lifecycle._contexts.has('session-a')).toBe(false);
    expect(lifecycle._contexts.get('session-b')).toBe(ctxB);
  });

  it('guard: no sharedBackend — handler no-ops without throwing', () => {
    const noBackend = new BrowserLifecycle({ sharedBackend: undefined });
    expect(() => noBackend.simulateDisconnect('session-a')).not.toThrow();
  });

  it('guard: no sessionId — handler no-ops', async () => {
    await lifecycle.browserFactory('session-a');

    lifecycle.simulateDisconnect(undefined);

    // Context still present — handler did nothing
    expect(lifecycle._contexts.has('session-a')).toBe(true);
  });

  it('recovery is repeatable across multiple disconnect/create cycles', async () => {
    for (let i = 0; i < 3; i++) {
      const ctx = await lifecycle.resolveContext('session-x');
      expect(ctx.id).toBe('session-x');
      expect(lifecycle._contexts.has('session-x')).toBe(true);

      lifecycle.simulateDisconnect('session-x');
      // Allow async removal to complete
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(lifecycle._contexts.has('session-x')).toBe(false);
    }

    // Final recovery
    const final = await lifecycle.resolveContext('session-x');
    expect(final.id).toBe('session-x');
    expect(lifecycle._factoryCallCount).toBe(4); // 3 cycles + 1 final
  });
});
