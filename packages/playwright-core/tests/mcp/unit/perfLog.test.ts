import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { PerfLog, nullPerfLog, createPerfLog } from 'playwright-core/src/tools/perfLog';

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

  it('setSession and setTool thread through to entries', async () => {
    const log = new PerfLog(tmpDir);
    log.setSession('sess-123');
    log.setTool('browser_click');
    await log.timeAsync(
        { phase: 'test', step: 'tool', side: 'server', target_ms: 0 },
        async () => {},
    );
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
  it('stamps callId on entries when set', async () => {
    const log = new PerfLog(tmpDir);
    log.setCallId('call-abc-123');
    await log.timeAsync(
        { phase: 'tool', step: 'e2e', side: 'server', target_ms: 0 },
        async () => {},
    );
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.callId).toBe('call-abc-123');
  });

  it('callId is undefined when not set', async () => {
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

  it('setCallId(undefined) clears the field', async () => {
    const log = new PerfLog(tmpDir);
    log.setCallId('call-xyz');
    await log.timeAsync(
        { phase: 'test', step: 'with-id', side: 'server', target_ms: 0 },
        async () => {},
    );
    log.setCallId(undefined);
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

  it('callId persists across multiple timeAsync calls within same set', async () => {
    const log = new PerfLog(tmpDir);
    log.setCallId('call-persist');
    for (let i = 0; i < 3; i++) {
      await log.timeAsync(
          { phase: 'test', step: `phase-${i}`, side: 'server', target_ms: 0 },
          async () => {},
      );
    }
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines)
      expect(JSON.parse(line).callId).toBe('call-persist');

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
