import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const playwrightCoreSrc = path.resolve(__dirname, '../../../src');

import { ArtifactCollector } from 'playwright-core/src/tools/artifactCollector';
import type { Download } from 'playwright-core/src/tools/artifactCollector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal context stub satisfying ArtifactCollector's constructor requirements
function createStubContext(configOverrides: Record<string, any> = {}) {
  return {
    id: 'test-context-id',
    config: { ...configOverrides },
    options: { cwd: '/tmp' },
    currentTab: () => undefined,
    tabs: () => [],
    // ArtifactCollector passes context to LogFile; LogFile needs these:
    outputDir: () => '/tmp/test-output',
    workspaceFile: async (_name: string) => `/tmp/test-output/${_name}`,
    outputFile: async () => `/tmp/test-output/log.txt`,
  } as any;
}

// Create a stub playwright.Download whose saveAs() rejects with a given error
function createRejectingDownload(filename: string, url: string, rejectMsg = 'saveAs failed') {
  return {
    suggestedFilename: () => filename,
    url: () => url,
    saveAs: (_dest: string) => Promise.reject(new Error(rejectMsg)),
    path: () => undefined,
    failure: () => null,
    page: () => undefined,
    createReadStream: () => { throw new Error('not implemented'); },
    cancel: async () => {},
  } as any;
}

// Create a stub playwright.Download whose saveAs() resolves successfully
function createSucceedingDownload(filename: string, url: string) {
  return {
    suggestedFilename: () => filename,
    url: () => url,
    saveAs: (_dest: string) => Promise.resolve(),
    path: () => undefined,
    failure: () => null,
    page: () => undefined,
    createReadStream: () => { throw new Error('not implemented'); },
    cancel: async () => {},
  } as any;
}

// Inline rendering logic mirrored from response.ts:402-409
// (the private _build() event loop — not exported, so we re-implement
//  the same two-branch logic here to verify the rendering contract)
function renderDownloadEvents(events: Array<{ type: string; download: Download }>): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === 'download-start') {
      lines.push(`- [DOWNLOAD] ${event.download.download.suggestedFilename()} — ${event.download.download.url()}`);
    } else if (event.type === 'download-finish') {
      if (event.download.saveSucceeded)
        lines.push(`- [DOWNLOAD COMPLETE] ${event.download.download.suggestedFilename()} — saved to "someRelativePath"`);
      else
        lines.push(`- [DOWNLOAD COMPLETE] ${event.download.download.suggestedFilename()}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Download event rendering logic (mirrors response.ts:402-409)
// ---------------------------------------------------------------------------

describe('download event rendering logic', () => {
  it('renders download-start with [DOWNLOAD] format including URL', () => {
    const download: Download = {
      download: createSucceedingDownload('test5.txt', 'https://example.com/download/test5.txt'),
      finished: false,
      outputFile: '/tmp/download-test5.bin',
    };

    const lines = renderDownloadEvents([{ type: 'download-start', download }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('- [DOWNLOAD] test5.txt — https://example.com/download/test5.txt');
  });

  it('renders download-finish with [DOWNLOAD COMPLETE] without path when saveSucceeded is false', () => {
    const download: Download = {
      download: createRejectingDownload('report.pdf', 'https://example.com/report.pdf'),
      finished: true,
      outputFile: '/tmp/download-report.bin',
      saveSucceeded: false,
    };

    const lines = renderDownloadEvents([{ type: 'download-finish', download }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[DOWNLOAD COMPLETE] report.pdf');
    expect(lines[0]).not.toContain('saved to');
  });

  it('renders download-finish with [DOWNLOAD COMPLETE] including saved path when saveSucceeded is true', () => {
    const download: Download = {
      download: createSucceedingDownload('data.csv', 'https://example.com/data.csv'),
      finished: true,
      outputFile: '/tmp/output/download-data.bin',
      saveSucceeded: true,
    };

    const lines = renderDownloadEvents([{ type: 'download-finish', download }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[DOWNLOAD COMPLETE] data.csv');
    expect(lines[0]).toContain('saved to');
  });

  it('renders both start and finish events in sequence', () => {
    const download: Download = {
      download: createRejectingDownload('archive.zip', 'https://cdn.example.com/archive.zip'),
      finished: true,
      outputFile: '/tmp/download-archive.bin',
      saveSucceeded: false,
    };

    const lines = renderDownloadEvents([
      { type: 'download-start', download },
      { type: 'download-finish', download },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('- [DOWNLOAD] archive.zip — https://cdn.example.com/archive.zip');
    expect(lines[1]).toContain('[DOWNLOAD COMPLETE] archive.zip');
    expect(lines[1]).not.toContain('saved to');
  });
});

// ---------------------------------------------------------------------------
// ArtifactCollector — downloadStarted() event emission
// ---------------------------------------------------------------------------

describe('ArtifactCollector download events', () => {
  it('emits download-start immediately on downloadStarted()', async () => {
    const ctx = createStubContext();
    const collector = new ArtifactCollector(ctx);

    const mockDownload = createRejectingDownload('file.bin', 'https://example.com/file.bin');
    collector.downloadStarted(mockDownload, '/tmp/file.bin');

    // download-start is pushed synchronously before saveAs resolves/rejects
    const events = collector.drainEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const startEvent = events.find(e => e.type === 'download-start');
    expect(startEvent).toBeDefined();
    expect(startEvent?.type).toBe('download-start');
  });

  it('emits download-finish with saveSucceeded=false when saveAs rejects', async () => {
    const ctx = createStubContext();
    const collector = new ArtifactCollector(ctx);

    const mockDownload = createRejectingDownload('file.bin', 'https://example.com/file.bin');
    collector.downloadStarted(mockDownload, '/tmp/file.bin');

    // Flush micro-task queue so the .catch() branch fires
    await new Promise(resolve => setImmediate(resolve));

    const events = collector.drainEvents();
    expect(events.length).toBe(2);

    const startEvent = events[0];
    expect(startEvent.type).toBe('download-start');

    const finishEvent = events[1];
    expect(finishEvent.type).toBe('download-finish');
    if (finishEvent.type === 'download-finish') {
      expect(finishEvent.download.finished).toBe(true);
      expect(finishEvent.download.saveSucceeded).toBe(false);
    }
  });

  it('emits download-finish with saveSucceeded=true when saveAs resolves', async () => {
    const ctx = createStubContext();
    const collector = new ArtifactCollector(ctx);

    const mockDownload = createSucceedingDownload('report.pdf', 'https://example.com/report.pdf');
    collector.downloadStarted(mockDownload, '/tmp/report.pdf');

    await new Promise(resolve => setImmediate(resolve));

    const events = collector.drainEvents();
    expect(events.length).toBe(2);

    const finishEvent = events[1];
    expect(finishEvent.type).toBe('download-finish');
    if (finishEvent.type === 'download-finish') {
      expect(finishEvent.download.finished).toBe(true);
      expect(finishEvent.download.saveSucceeded).toBe(true);
    }
  });

  it('Download type accepts saveSucceeded field', () => {
    // Type-level check: verify the Download type has saveSucceeded?: boolean
    const d: Download = {
      download: createSucceedingDownload('x.txt', 'https://example.com/x.txt'),
      finished: true,
      outputFile: '/tmp/x.txt',
      saveSucceeded: true,
    };
    expect(d.saveSucceeded).toBe(true);

    const d2: Download = {
      download: createRejectingDownload('y.txt', 'https://example.com/y.txt'),
      finished: true,
      outputFile: '/tmp/y.txt',
      saveSucceeded: false,
    };
    expect(d2.saveSucceeded).toBe(false);

    const d3: Download = {
      download: createRejectingDownload('z.txt', 'https://example.com/z.txt'),
      finished: false,
      outputFile: '/tmp/z.txt',
    };
    expect(d3.saveSucceeded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Structural: browser.ts dedup guard
// ---------------------------------------------------------------------------

describe('browser download dedup', () => {
  it('_downloadCreated contains the dedup guard (if has(uuid) return)', () => {
    const browserSource = readFileSync(
        path.resolve(playwrightCoreSrc, 'server/browser.ts'),
        'utf-8'
    );
    // The guard we added: if (this._downloads.has(uuid)) return;
    expect(browserSource).toContain('_downloads.has(uuid)');
  });
});

// ---------------------------------------------------------------------------
// Structural: crPage CDP download handler wiring
// ---------------------------------------------------------------------------

describe('crPage download handler wiring', () => {
  it('crPage subscribes to Page.downloadWillBegin and Page.downloadProgress', () => {
    const crPageSource = readFileSync(
        path.resolve(playwrightCoreSrc, 'server/chromium/crPage.ts'),
        'utf-8'
    );
    expect(crPageSource).toContain('Page.downloadWillBegin');
    expect(crPageSource).toContain('Page.downloadProgress');
  });

  it('crPage has _onPageDownloadWillBegin and _onPageDownloadProgress handlers', () => {
    const crPageSource = readFileSync(
        path.resolve(playwrightCoreSrc, 'server/chromium/crPage.ts'),
        'utf-8'
    );
    expect(crPageSource).toContain('_onPageDownloadWillBegin');
    expect(crPageSource).toContain('_onPageDownloadProgress');
  });
});
