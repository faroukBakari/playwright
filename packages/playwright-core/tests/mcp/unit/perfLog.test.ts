import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { z } from 'playwright-core/src/mcpBundle';
import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { PerfLog, nullPerfLog, createPerfLog } from 'playwright-core/src/tools/perfLog';
import { runInRequestScope } from 'playwright-core/src/tools/requestScope';
import { defineTool } from 'playwright-core/src/tools/tool';
import type { RequestScope } from 'playwright-core/src/tools/requestScope';

vi.mock('playwright-core/src/mcp/log', () => ({ serverLog: vi.fn(), logUnhandledError: vi.fn() }));

function inCall<T>(labels: Partial<RequestScope>, fn: () => T): T {
  return runInRequestScope({ callId: 'call-fixture', tool: 'fixture_tool', deadline: Date.now() + 5000, ...labels }, fn);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perflog-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Await stream flush before reading files — PerfLog.close() is fire-and-forget. */
async function closeAndFlush(log: PerfLog): Promise<void> {
  const stream = (log as any)._stream as fs.WriteStream | null;
  if (!stream) { log.close(); return; }
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end();
  });
  (log as any)._stream = null;
}

describe('PerfLog', () => {
  it('timeAsync returns the wrapped function result', async () => {
    const log = new PerfLog(tmpDir);
    const result = await log.timeAsync(
        { phase: 'test', step: 'compute', side: 'server', target_ms: 0 },
        async () => 42,
    );
    expect(result).toBe(42);
    await closeAndFlush(log);
  });

  it('timeAsync measures wall-clock time', async () => {
    const log = new PerfLog(tmpDir);
    await log.timeAsync(
        { phase: 'test', step: 'sleep', side: 'server', target_ms: 50 },
        () => new Promise(r => setTimeout(r, 50)),
    );
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.actual_ms).toBeGreaterThanOrEqual(40);
    expect(entry.actual_ms).toBeLessThan(200);
  });

  it('creates JSONL file on first write (lazy init)', async () => {
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    const log = new PerfLog(tmpDir);
    await log.timeAsync(
        { phase: 'test', step: 'init', side: 'server', target_ms: 0 },
        async () => {},
    );
    await closeAndFlush(log);
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^perf-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  it('entry contains all required fields', async () => {
    const log = new PerfLog(tmpDir);
    await log.timeAsync(
        { phase: 'action', step: 'click', side: 'chrome', target_ms: 100 },
        async () => 'ok',
    );
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry).toMatchObject({
      phase: 'action',
      step: 'click',
      side: 'chrome',
      target_ms: 100,
    });
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof entry.actual_ms).toBe('number');
  });

  it('session id and the scope tool thread through to entries', async () => {
    const log = new PerfLog(tmpDir);
    log.setSession('sess-123');
    await inCall({ tool: 'browser_click' }, () => log.timeAsync(
        { phase: 'test', step: 'tool', side: 'server', target_ms: 0 },
        async () => {},
    ));
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim().split('\n');
    // First line is session-init from setSession, second is the timeAsync entry
    const toolEntry = JSON.parse(lines[lines.length - 1]);
    expect(toolEntry.sid).toBe('sess-123');
    expect(toolEntry.tool).toBe('browser_click');
  });

  it('setSession writes a session-init entry', async () => {
    const log = new PerfLog(tmpDir);
    log.setSession('sess-abc');
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.phase).toBe('session');
    expect(entry.step).toBe('init');
    expect(entry.sid).toBe('sess-abc');
    expect(entry.actual_ms).toBe(0);
  });

  it('setClientId stamps clientId on entries', async () => {
    const log = new PerfLog(tmpDir);
    log.setClientId('ctx-uuid-123');
    await log.timeAsync(
        { phase: 'test', step: 'check', side: 'server', target_ms: 0 },
        async () => {},
    );
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.clientId).toBe('ctx-uuid-123');
  });

  it('session-init entry includes clientId when set before setSession', async () => {
    const log = new PerfLog(tmpDir);
    log.setClientId('ctx-before');
    log.setSession('sess-order');
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.phase).toBe('session');
    expect(entry.clientId).toBe('ctx-before');
  });

  it('multiple timeAsync calls append to same file', async () => {
    const log = new PerfLog(tmpDir);
    for (let i = 0; i < 3; i++) {
      await log.timeAsync(
          { phase: 'test', step: `step-${i}`, side: 'server', target_ms: 0 },
          async () => {},
      );
    }
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    lines.forEach(line => expect(() => JSON.parse(line)).not.toThrow());
  });

  it('close() does not crash on double-close', () => {
    const log = new PerfLog(tmpDir);
    log.close();
    log.close(); // should not throw
  });
});

describe('nullPerfLog', () => {
  it('passes through without writing anything', async () => {
    const result = await nullPerfLog.timeAsync(
        { phase: 'test', step: 'noop', side: 'server', target_ms: 0 },
        async () => 'passthrough',
    );
    expect(result).toBe('passthrough');
  });

  it('setSession and setClientId are no-ops', () => {
    // Should not throw or write anything
    nullPerfLog.setSession('should-not-write');
    nullPerfLog.setClientId('should-not-write');
  });
});

describe('callId tracking', () => {
  it('stamps callId on entries written inside a call', async () => {
    const log = new PerfLog(tmpDir);
    await inCall({ callId: 'call-abc-123' }, () => log.timeAsync(
        { phase: 'tool', step: 'e2e', side: 'server', target_ms: 0 },
        async () => {},
    ));
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.callId).toBe('call-abc-123');
  });

  it('callId is undefined outside a call', async () => {
    const log = new PerfLog(tmpDir);
    await log.timeAsync(
        { phase: 'test', step: 'no-call', side: 'server', target_ms: 0 },
        async () => {},
    );
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.callId).toBeUndefined();
  });

  it('callId is gone once the call has ended', async () => {
    const log = new PerfLog(tmpDir);
    await inCall({ callId: 'call-xyz' }, () => log.timeAsync(
        { phase: 'test', step: 'with-id', side: 'server', target_ms: 0 },
        async () => {},
    ));
    await log.timeAsync(
        { phase: 'test', step: 'without-id', side: 'server', target_ms: 0 },
        async () => {},
    );
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.callId).toBe('call-xyz');
    expect(second.callId).toBeUndefined();
  });

  it('callId persists across multiple timeAsync calls within the same call', async () => {
    const log = new PerfLog(tmpDir);
    await inCall({ callId: 'call-persist' }, async () => {
      for (let i = 0; i < 3; i++) {
        await log.timeAsync(
            { phase: 'test', step: `phase-${i}`, side: 'server', target_ms: 0 },
            async () => {},
        );
      }
    });
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines)
      expect(JSON.parse(line).callId).toBe('call-persist');

  });
});

describe('per-call labels', () => {
  it('regression: two interleaved calls each write their own tool, call id and client id', async () => {
    const log = new PerfLog(tmpDir);
    log.setClientId('default-client');
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => releaseFirst = resolve);
    const deadline = Date.now() + 5000;

    const first = runInRequestScope({ callId: 'call-1', tool: 'tool_one', sessionId: 'session-1', deadline }, () => log.timeAsync(
        { phase: 'tool', step: 'first', side: 'server', target_ms: 0 },
        () => gate,
    ));
    await runInRequestScope({ callId: 'call-2', tool: 'tool_two', sessionId: 'session-2', deadline }, () => log.timeAsync(
        { phase: 'tool', step: 'second', side: 'server', target_ms: 0 },
        async () => {},
    ));
    releaseFirst();
    await first;
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entries = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(entries.find(entry => entry.step === 'first')).toMatchObject({ tool: 'tool_one', callId: 'call-1', clientId: 'session-1' });
    expect(entries.find(entry => entry.step === 'second')).toMatchObject({ tool: 'tool_two', callId: 'call-2', clientId: 'session-2' });
  });
});

describe('tool call telemetry through the backend', () => {
  it('a tool call writes its end-to-end entry with its own labels and outcome', async () => {
    const echo = defineTool({
      capability: 'core',
      noTabRequired: true,
      schema: {
        name: 'fixture_echo', title: 'Echo fixture', description: 'Returns at once',
        inputSchema: z.object({}), type: 'action',
      },
      handle: async (_context, _params, response) => {
        response.addTextResult('done');
        response.setIncludeSnapshot('none');
      },
    });
    const factory = async () => ({ pages: () => [], on: () => {}, off: () => {}, browser: () => null }) as any;
    const backend = new BrowserServerBackend({ codegen: 'none' } as any, null, [echo], tmpDir, factory);
    await backend.initialize({ cwd: tmpDir } as any);

    const result = await backend.callTool('fixture_echo', {}, async () => {}, 'session-telemetry');
    await closeAndFlush((backend as any)._perfLog);
    await backend.dispose();

    expect(result.isError).not.toBe(true);
    const perfDir = path.join(tmpDir, '.local', 'perf');
    const lines = fs.readFileSync(path.join(perfDir, fs.readdirSync(perfDir)[0]), 'utf8').trim().split('\n');
    const endToEnd = lines.map(line => JSON.parse(line)).find(entry => entry.step === 'e2e');
    expect(endToEnd).toMatchObject({ phase: 'tool', tool: 'fixture_echo', clientId: 'session-telemetry', outcome: 'success' });
    expect(endToEnd.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(endToEnd.response_chars).toBeGreaterThan(0);
  });
});

describe('createPerfLog', () => {
  it('creates correct directory structure', async () => {
    const log = createPerfLog(tmpDir);
    await log.timeAsync(
        { phase: 'test', step: 'factory', side: 'server', target_ms: 0 },
        async () => {},
    );
    await closeAndFlush(log);

    const perfDir = path.join(tmpDir, '.local', 'perf');
    expect(fs.existsSync(perfDir)).toBe(true);
    const files = fs.readdirSync(perfDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^perf-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });
});
