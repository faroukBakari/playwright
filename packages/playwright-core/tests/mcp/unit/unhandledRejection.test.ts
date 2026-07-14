import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { setupExitWatchdog } from 'playwright-core/src/mcp/watchdog';

// ---------------------------------------------------------------------------
// Unhandled rejection resilience — watchdog + orphaned promise handling
// ---------------------------------------------------------------------------

describe('watchdog unhandledRejection handler', () => {
  let originalListeners: Function[];
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Save and remove existing unhandledRejection listeners (including vitest's)
    originalListeners = process.rawListeners('unhandledRejection') as Function[];
    process.removeAllListeners('unhandledRejection');

    // Spy on process.exit to verify it is NOT called
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    // Capture stderr writes (serverLog writes to stderr)
    // eslint-disable-next-line no-restricted-properties
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    stderrSpy.mockRestore();

    // Remove watchdog listener and restore original listeners
    process.removeAllListeners('unhandledRejection');
    for (const listener of originalListeners)
      process.on('unhandledRejection', listener as any);
  });

  it('logs but does not exit on unhandled rejection', () => {
    setupExitWatchdog();

    // Simulate an unhandled rejection by emitting the event directly
    const testError = new Error('orphaned tool promise rejection');
    process.emit('unhandledRejection' as any, testError, Promise.resolve());

    // Should NOT have called process.exit
    expect(processExitSpy).not.toHaveBeenCalled();

    // Should have logged to stderr with [rejection] category
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('[rejection]');
    expect(output).toContain('non-fatal');
    expect(output).toContain('orphaned tool promise rejection');
  });

  it('logs string reasons', () => {
    setupExitWatchdog();

    process.emit('unhandledRejection' as any, 'string reason', Promise.resolve());

    expect(processExitSpy).not.toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('string reason');
  });

  it('logs error stack when available', () => {
    setupExitWatchdog();

    const error = new Error('with stack');
    process.emit('unhandledRejection' as any, error, Promise.resolve());

    expect(processExitSpy).not.toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('with stack');
    expect(output).toContain('unhandledRejection.test.ts'); // stack points here
  });

  it('still exits on uncaughtException', () => {
    setupExitWatchdog();

    const error = new Error('sync crash');
    process.emit('uncaughtException' as any, error);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

describe('orphaned tool promise catch (callTool integration)', () => {
  // These tests verify the Promise.race orphan-catch pattern at the
  // behavioral level without constructing a full BrowserServerBackend.
  // The pattern: when timeout wins the race, the loser promise gets a
  // .catch() attached so its eventual rejection doesn't become unhandled.

  it('orphaned promise rejection does not become unhandled', async () => {
    const unhandledRejections: unknown[] = [];
    const listener = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', listener);

    try {
      // Simulate the callTool pattern:
      // toolPromise rejects after timeout fires
      const toolPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('tool failed after timeout')), 50);
      });

      let timedOut = false;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(new Error('Tool "test_tool" timed out after 10ms'));
        }, 10);
      });

      try {
        await Promise.race([toolPromise, timeoutPromise]);
      } catch (e) {
        if (timedOut) {
          // This is the pattern from browserServerBackend.ts
          toolPromise.catch(() => { /* orphaned rejection caught */ });
        }
        // Timeout error is expected
        expect(String(e)).toContain('timed out');
      }

      // Wait for the orphaned promise to reject
      await new Promise(r => setTimeout(r, 100));

      // No unhandled rejections should have fired
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.removeListener('unhandledRejection', listener);
    }
  });

  it('normal tool errors are not caught as orphans', async () => {
    // When the tool rejects BEFORE timeout, timedOut is false,
    // so no .catch() is attached — the error propagates normally.
    const toolPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('tool error')), 10);
    });

    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        timedOut = true;
        reject(new Error('timeout'));
      }, 100);
    });

    let caughtError: Error | undefined;
    try {
      await Promise.race([toolPromise, timeoutPromise]);
    } catch (e) {
      caughtError = e as Error;
      if (timedOut)
        toolPromise.catch(() => {});

    }

    // Tool error won the race, not timeout
    expect(timedOut).toBe(false);
    expect(caughtError?.message).toBe('tool error');
  });
});
