import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { SessionGraceManager } from 'playwright-core/src/mcp/sessionGrace';
import type { GracedSession } from 'playwright-core/src/mcp/sessionGrace';

describe('SessionGraceManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('TTL=0 persistent grace', () => {
    it('records session without scheduling a timer', () => {
      const mgr = new SessionGraceManager(0);
      const onExpire = vi.fn();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const entered = mgr.enter('sess-1', 'cdp-1', null, 42, onExpire);

      expect(entered).toBe(true);
      expect(mgr.size).toBe(1);
      expect(setTimeoutSpy).not.toHaveBeenCalled();

      // Advance time well past any plausible TTL — must not fire.
      vi.advanceTimersByTime(60_000);
      expect(onExpire).not.toHaveBeenCalled();
      expect(mgr.size).toBe(1);
    });

    it('cancel(sessionId) removes a persistent-grace entry', () => {
      const mgr = new SessionGraceManager(0);
      const onExpire = vi.fn();
      mgr.enter('sess-1', 'cdp-1', null, 42, onExpire);

      const graced = mgr.cancel('sess-1');

      expect(graced).not.toBeNull();
      expect(graced?.sessionId).toBe('sess-1');
      expect(graced?.timer).toBeNull();
      expect(mgr.size).toBe(0);
      expect(onExpire).not.toHaveBeenCalled();
    });

    it('cancelAll() removes persistent-grace entries and invokes callback', () => {
      const mgr = new SessionGraceManager(0);
      const onExpire = vi.fn();
      mgr.enter('sess-1', 'cdp-1', null, 11, onExpire);
      mgr.enter('sess-2', 'cdp-2', null, 22, onExpire);
      expect(mgr.size).toBe(2);

      const cbSeen: string[] = [];
      mgr.cancelAll((sid: string, _g: GracedSession) => cbSeen.push(sid));

      expect(mgr.size).toBe(0);
      expect(cbSeen.sort()).toEqual(['sess-1', 'sess-2']);
      expect(onExpire).not.toHaveBeenCalled();
    });

    it('skips sessions with null cdpSessionId regardless of TTL=0', () => {
      const mgr = new SessionGraceManager(0);
      const onExpire = vi.fn();

      const entered = mgr.enter('sess-1', null, null, null, onExpire);

      expect(entered).toBe(false);
      expect(mgr.size).toBe(0);
    });
  });

  describe('TTL>0 timer-based grace (regression guard)', () => {
    it('schedules a timer and fires onExpire after TTL', () => {
      const mgr = new SessionGraceManager(5000);
      const onExpire = vi.fn();

      mgr.enter('sess-1', 'cdp-1', null, 7, onExpire);
      expect(mgr.size).toBe(1);

      vi.advanceTimersByTime(4999);
      expect(onExpire).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(onExpire).toHaveBeenCalledWith('sess-1', expect.objectContaining({ sessionId: 'sess-1', cdpSessionId: 'cdp-1', tabId: 7 }));
      expect(mgr.size).toBe(0);
    });

    it('cancel(sessionId) clears the timer before it fires', () => {
      const mgr = new SessionGraceManager(5000);
      const onExpire = vi.fn();
      mgr.enter('sess-1', 'cdp-1', null, 7, onExpire);

      const graced = mgr.cancel('sess-1');

      expect(graced?.sessionId).toBe('sess-1');
      vi.advanceTimersByTime(10_000);
      expect(onExpire).not.toHaveBeenCalled();
      expect(mgr.size).toBe(0);
    });
  });
});
