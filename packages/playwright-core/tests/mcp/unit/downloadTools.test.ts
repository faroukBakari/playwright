import http from 'node:http';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { Context } from 'playwright-core/src/tools/context';
import downloadTools from 'playwright-core/src/tools/downloads';
import type { AddressInfo } from 'node:net';

vi.mock('playwright-core/src/mcp/log', () => ({ serverLog: vi.fn(), logUnhandledError: vi.fn() }));

type Outcome = Awaited<ReturnType<BrowserServerBackend['callTool']>>;

const SESSION = 'session-a';
const DOWNLOAD = {
  id: 7,
  state: 'complete',
  filename: 'C:\\Users\\fixture\\Downloads\\report.pdf',
  fileSize: 1024,
  mime: 'application/pdf',
  url: 'https://fixture.invalid/report.pdf',
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup();
  vi.restoreAllMocks();
});

async function createFixture(options: { withTab: boolean }) {
  const config = {
    codegen: 'none',
    snapshot: { mode: 'none' },
    timeouts: { budget: { default: 2000, navigate: 2000, runCode: 2000 } },
  } as ConstructorParameters<typeof BrowserServerBackend>[0];
  const context = new Context({} as any, { config, cwd: os.tmpdir() });
  context.setClientId(SESSION);
  const tabs = options.withTab ? [{ page: { url: () => 'about:blank' }, dispose: vi.fn().mockResolvedValue(undefined) }] : [];
  Object.assign(context, { _tabs: tabs, _currentTab: tabs[0] });

  // Stands in for the relay sideband, which answers download requests from Chrome's download API.
  const relay = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/downloads/list') {
        res.end(JSON.stringify({ result: { downloads: [DOWNLOAD] } }));
      } else if (req.method === 'POST' && req.url === '/downloads/file') {
        res.end(JSON.stringify({ result: DOWNLOAD }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  vi.spyOn(context, 'relayHttpUrl', 'get').mockReturnValue(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);

  const backend = new BrowserServerBackend(config, null, downloadTools);
  vi.spyOn(backend as any, '_resolveContext').mockResolvedValue(context);
  cleanups.push(async () => {
    await backend.dispose();
    await context.dispose();
    await new Promise(resolve => relay.close(resolve));
  });
  return {
    call: (tool: string, args: Record<string, unknown> = {}) => backend.callTool(tool, args, async () => {}, SESSION),
  };
}

function textOf(outcome: Outcome): string {
  return (outcome.content ?? []).map(part => part.type === 'text' ? part.text : '').join('\n');
}

describe('download tools', () => {
  it('regression: browser_download_list in a session without a tab returns the relay list', async () => {
    const f = await createFixture({ withTab: false });

    const outcome = await f.call('browser_download_list');

    expect(textOf(outcome)).toContain(DOWNLOAD.filename);
    expect(outcome.isError).toBeFalsy();
  });

  it('regression: browser_download_file in a session without a tab returns the completed download', async () => {
    const f = await createFixture({ withTab: false });

    const outcome = await f.call('browser_download_file', { url: DOWNLOAD.url });

    expect(textOf(outcome)).toContain(DOWNLOAD.filename);
    expect(outcome.isError).toBeFalsy();
  });

  it('control: browser_download_list in a session with a tab returns the relay list', async () => {
    const f = await createFixture({ withTab: true });

    const outcome = await f.call('browser_download_list');

    expect(textOf(outcome)).toContain(DOWNLOAD.filename);
    expect(outcome.isError).toBeFalsy();
  });
});
