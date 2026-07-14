import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ErrorLog, createErrorLog } from 'playwright-core/src/tools/errorLog';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorlog-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Await stream flush before reading files — ErrorLog.close() is fire-and-forget. */
async function closeAndFlush(log: ErrorLog): Promise<void> {
  const stream = (log as any)._stream as fs.WriteStream | null;
  if (!stream) { log.close(); return; }
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end();
  });
  (log as any)._stream = null;
}

describe('ErrorLog', () => {
  it('creates JSONL file on first log (lazy init)', async () => {
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    const log = new ErrorLog(tmpDir);
    log.log('browser_click', 'call-1', new Error('element not found'));
    await closeAndFlush(log);
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^errors-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  it('entry contains all required fields', async () => {
    const log = new ErrorLog(tmpDir);
    log.setSession('sess-abc');
    const err = new Error('timeout waiting for selector');
    log.log('browser_wait', 'call-xyz', err);
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry).toMatchObject({
      sid: 'sess-abc',
      tool: 'browser_wait',
      callId: 'call-xyz',
      error: 'Error: timeout waiting for selector',
    });
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.stack).toContain('timeout waiting for selector');
  });

  it('captures stack trace from Error objects', async () => {
    const log = new ErrorLog(tmpDir);
    const err = new Error('navigation failed');
    log.log('browser_navigate', 'call-1', err);
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.stack).toBeDefined();
    expect(entry.stack).toContain('Error: navigation failed');
    expect(entry.stack).toContain('errorLog.test.ts');
  });

  it('handles non-Error thrown values (string, object)', async () => {
    const log = new ErrorLog(tmpDir);
    log.log('browser_click', 'call-1', 'plain string error');
    log.log('browser_click', 'call-2', { code: 'TIMEOUT', detail: 'too slow' });
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.error).toBe('plain string error');
    expect(first.stack).toBeUndefined();

    const second = JSON.parse(lines[1]);
    expect(second.error).toBe('[object Object]');
    expect(second.stack).toBeUndefined();
  });

  it('multiple errors append to same file', async () => {
    const log = new ErrorLog(tmpDir);
    for (let i = 0; i < 5; i++)
      log.log('browser_click', `call-${i}`, new Error(`error ${i}`));
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    lines.forEach(line => expect(() => JSON.parse(line)).not.toThrow());
  });

  it('session ID is optional', async () => {
    const log = new ErrorLog(tmpDir);
    // No setSession call
    log.log('browser_snapshot', 'call-1', new Error('page closed'));
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.sid).toBeUndefined();
    expect(entry.tool).toBe('browser_snapshot');
  });

  it('close() does not crash on double-close', () => {
    const log = new ErrorLog(tmpDir);
    log.close();
    log.close(); // should not throw
  });

  it('includes timeout_ms and actual_ms when extras are provided', async () => {
    const log = new ErrorLog(tmpDir);
    log.setSession('sess-timeout');
    const err = new Error('Tool "browser_navigate" timed out after 15000ms');
    log.log('browser_navigate', 'call-t1', err, { timeout_ms: 15000, actual_ms: 15023 });
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry).toMatchObject({
      tool: 'browser_navigate',
      callId: 'call-t1',
      timeout_ms: 15000,
      actual_ms: 15023,
    });
  });

  it('omits timeout_ms and actual_ms when extras are not provided', async () => {
    const log = new ErrorLog(tmpDir);
    log.log('browser_click', 'call-no-extras', new Error('element not found'));
    await closeAndFlush(log);

    const files = fs.readdirSync(tmpDir);
    const entry = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim());
    expect(entry.timeout_ms).toBeUndefined();
    expect(entry.actual_ms).toBeUndefined();
  });
});

describe('createErrorLog', () => {
  it('creates correct directory structure under .local/errors/', async () => {
    const log = createErrorLog(tmpDir);
    log.log('browser_navigate', 'call-1', new Error('test'));
    await closeAndFlush(log);

    const errDir = path.join(tmpDir, '.local', 'errors');
    expect(fs.existsSync(errDir)).toBe(true);
    const files = fs.readdirSync(errDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^errors-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });
});
