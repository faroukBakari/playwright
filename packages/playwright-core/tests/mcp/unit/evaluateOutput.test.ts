import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Context } from 'playwright-core/src/tools/context';
import evaluateTools from 'playwright-core/src/tools/evaluate';
import { Response } from 'playwright-core/src/tools/response';

const inlineLimit = 64;
const largeObject = { items: [{ name: 'x'.repeat(inlineLimit) }] };

afterEach(() => vi.restoreAllMocks());

function createFixture(value: unknown) {
  const context = new Context({} as any, {
    config: { codegen: 'none', evaluate: { maxResultLength: inlineLimit } } as any,
    cwd: os.tmpdir(),
  });
  const evaluate = vi.fn().mockResolvedValue(value);
  const tab = { context, page: { _evaluateFunction: evaluate }, modalStates: () => [] };
  vi.spyOn(context, 'ensureTab').mockResolvedValue(tab as any);
  const response = new Response(context, 'browser_evaluate', {});
  const fileSink = vi.spyOn(response, 'addFileResult').mockResolvedValue(undefined);
  return {
    evaluate,
    response,
    fileSink,
    async run(filename?: string) {
      await evaluateTools[0].handle(context, { function: '() => "fixture"', filename }, response);
    },
    async cleanup() { await context.dispose(); },
  };
}

describe('evaluate output unit boundary', () => {
  it('regression: string JSON file output is complete beyond the inline limit', async () => {
    const json = JSON.stringify(largeObject);
    expect(json.length).toBeGreaterThan(inlineLimit);
    const f = createFixture(json);
    try {
      await f.run('fixture-string.json');

      expect(f.evaluate).toHaveBeenCalledOnce();
      expect(f.fileSink).toHaveBeenCalledOnce();
      const text = f.fileSink.mock.calls[0][1] as string;
      expect(text).toBe(json);
      expect(JSON.parse(text)).toEqual(largeObject);
    } finally {
      await f.cleanup();
    }
  });

  it('regression: object JSON file output is complete beyond the inline limit', async () => {
    const serialized = JSON.stringify(largeObject, null, 2);
    expect(serialized.length).toBeGreaterThan(inlineLimit);
    const f = createFixture(largeObject);
    try {
      await f.run('fixture-object.json');

      expect(f.fileSink).toHaveBeenCalledOnce();
      const text = f.fileSink.mock.calls[0][1] as string;
      expect(text).toBe(serialized);
      expect(JSON.parse(text)).toEqual(largeObject);
    } finally {
      await f.cleanup();
    }
  });

  it('control: inline output retains its configured truncation marker', async () => {
    const serialized = JSON.stringify(largeObject, null, 2);
    const f = createFixture(largeObject);
    try {
      await f.run();
      const result = await f.response.serialize();

      expect(f.fileSink).not.toHaveBeenCalled();
      expect(result.content).toEqual([
        { type: 'text', text: expect.stringContaining(serialized.slice(0, inlineLimit)) },
      ]);
      expect(result.content).toEqual([
        { type: 'text', text: expect.stringContaining(`[truncated: ${serialized.length} chars, limit ${inlineLimit}]`) },
      ]);
    } finally {
      await f.cleanup();
    }
  });

  it('control: under-limit string file output remains unchanged', async () => {
    const json = JSON.stringify({ ok: true });
    const f = createFixture(json);
    try {
      await f.run('fixture-short.json');

      expect(f.fileSink).toHaveBeenCalledOnce();
      const [file, text] = f.fileSink.mock.calls[0];
      expect(file.fileName).toContain('fixture-short.json');
      expect(text).toBe(json);
      expect(JSON.parse(text as string)).toEqual({ ok: true });
    } finally {
      await f.cleanup();
    }
  });
});
