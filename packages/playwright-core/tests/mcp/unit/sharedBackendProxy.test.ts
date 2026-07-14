import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SharedBackendProxy } from 'playwright-core/src/tools/browserServerBackend';

// Minimal BrowserServerBackend stub
function createStubBackend() {
  const calls: Array<{ name: string; args: any; sessionId?: string }> = [];
  const removedContexts: string[] = [];
  const backend = {
    initialized: false,
    browserContext: { browser: () => null } as any,
    initialize: vi.fn(async () => { backend.initialized = true; }),
    callTool: vi.fn(async (name: string, args: any, _progress: any, sessionId?: string) => {
      calls.push({ name, args, sessionId });
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    }),
    removeContext: vi.fn(async (id: string) => { removedContexts.push(id); }),
    dispose: vi.fn(async () => {}),
  } as any;
  return { backend, calls, removedContexts };
}

describe('SharedBackendProxy', () => {
  let stub: ReturnType<typeof createStubBackend>;
  let proxy: SharedBackendProxy;
  const sessionId = 'session-abc-123';

  beforeEach(() => {
    stub = createStubBackend();
    proxy = new SharedBackendProxy(stub.backend, sessionId);
  });

  it('passes sessionId as explicit parameter (not injected into args)', async () => {
    await proxy.callTool('browser_navigate', { url: 'https://example.com' }, () => {});
    expect(stub.backend.callTool).toHaveBeenCalledOnce();
    // sessionId passed as 4th arg, not smuggled into rawArguments
    const passedArgs = stub.backend.callTool.mock.calls[0][1];
    const passedSessionId = stub.backend.callTool.mock.calls[0][3];
    expect(passedArgs).toEqual({ url: 'https://example.com' });
    expect(passedSessionId).toBe(sessionId);
  });

  it('does not modify rawArguments', async () => {
    const originalArgs = { ref: 'btn1', extra: 'value' };
    await proxy.callTool('browser_click', originalArgs, () => {});
    const passedArgs = stub.backend.callTool.mock.calls[0][1];
    // Args passed through unmodified — no browserClientId injection
    expect(passedArgs).toEqual({ ref: 'btn1', extra: 'value' });
    expect(passedArgs).not.toHaveProperty('browserClientId');
  });

  it('initializes backend only once for first proxy', async () => {
    stub.backend.initialized = false;
    await proxy.initialize({ cwd: '/tmp' });
    expect(stub.backend.initialize).toHaveBeenCalledOnce();

    // Second proxy — backend already initialized
    const proxy2 = new SharedBackendProxy(stub.backend, 'session-def-456');
    await proxy2.initialize({ cwd: '/tmp' });
    expect(stub.backend.initialize).toHaveBeenCalledOnce(); // still 1
  });

  it('skips initialization when backend already initialized', async () => {
    stub.backend.initialized = true;
    await proxy.initialize({ cwd: '/tmp' });
    expect(stub.backend.initialize).not.toHaveBeenCalled();
  });

  it('dispose is a no-op', async () => {
    await proxy.dispose();
    expect(stub.backend.dispose).not.toHaveBeenCalled();
  });

  it('removeSessionContext delegates to backend.removeContext', async () => {
    await proxy.removeSessionContext();
    expect(stub.removedContexts).toEqual([sessionId]);
  });

  it('passes progress callback through to backend', async () => {
    const progress = vi.fn();
    await proxy.callTool('browser_snapshot', {}, progress);
    expect(stub.backend.callTool).toHaveBeenCalledWith(
        'browser_snapshot',
        {},
        progress,
        sessionId,
    );
  });
});
