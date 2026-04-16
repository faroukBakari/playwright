/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { z } from '../mcpBundle';
import { defineTabTool } from './tool';
import { snapshotOptionsSchema } from './snapshot';

// ---------------------------------------------------------------------------
// WSL detection (cached)
// ---------------------------------------------------------------------------

let _isWSL: boolean | undefined;

function isWSL(): boolean {
  if (_isWSL === undefined) {
    try {
      const version = fs.readFileSync('/proc/version', 'utf8');
      _isWSL = /microsoft|wsl/i.test(version);
    } catch {
      _isWSL = false;
    }
  }
  return _isWSL;
}

/** Reset the cached WSL detection. Exported for unit tests only. */
export function _resetWSLCache(): void {
  _isWSL = undefined;
}

// ---------------------------------------------------------------------------
// MIME type lookup
// ---------------------------------------------------------------------------

const mimeTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'text/typescript',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return mimeTypes[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Path normalization and validation
// ---------------------------------------------------------------------------

/** Windows drive-letter path: C:\... or C:/... */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[/\\]/;
/** UNC path: \\server\share or //server/share */
const UNC_RE = /^(?:\\\\|\/\/)/;

/**
 * Convert a Windows drive-letter path to a POSIX /mnt/<drive>/... path
 * without invoking wslpath. Used as a fallback when wslpath is unavailable.
 *
 * FIXME: fallback passthrough: Windows path regex conversion — degrading to
 * manual /mnt/<drive>/... mapping instead of wslpath -u.
 * Owner: expert-tools. Since: 2026-04-16. Remove-by: when wslpath is
 * confirmed always present on WSL2 (currently safe assumption).
 */
function windowsDriveToMountPath(p: string): string {
  // Normalise separators: C:\foo\bar → C:/foo/bar
  const withForward = p.replace(/\\/g, '/');
  // Extract drive letter and remainder: "C:/foo/bar" → drive="c", rest="/foo/bar"
  const drive = withForward[0].toLowerCase();
  const rest = withForward.slice(2); // strip "C:"
  return `/mnt/${drive}${rest}`;
}

/**
 * Convert a UNC wsl$ path to a POSIX path without invoking wslpath.
 * \\wsl$\Ubuntu\home\farouk\file → /home/farouk/file
 * //wsl$/Ubuntu/home/farouk/file → /home/farouk/file
 *
 * Non-wsl$ UNC paths (real network shares) are returned as null — the caller
 * must throw a clear error for those.
 *
 * FIXME: fallback passthrough: UNC wsl$ path regex conversion — degrading to
 * manual prefix-strip instead of wslpath -u.
 * Owner: expert-tools. Since: 2026-04-16. Remove-by: when wslpath is
 * confirmed always present on WSL2 (currently safe assumption).
 */
function wslUncToMountPath(p: string): string | null {
  // Normalise separators
  const withForward = p.replace(/\\/g, '/');
  // Match //wsl$/DistroName/... or //wsl.localhost/DistroName/...
  const wslMatch = /^\/\/wsl(?:\$|\.localhost)\/[^/]+(\/.*)$/i.exec(withForward);
  if (wslMatch)
    return wslMatch[1]; // the POSIX path portion
  return null;
}

/**
 * Try converting a Windows/UNC path to a POSIX path using `wslpath -u`.
 * Returns the converted path on success, or null if wslpath is not available.
 * Throws if wslpath runs but returns an error (bad input).
 */
function tryWslpath(p: string): string | null {
  try {
    const result = child_process.execFileSync('wslpath', ['-u', p], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return result.trim();
  } catch (e: unknown) {
    // ENOENT → wslpath binary not found → fall back to regex
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return null;
    // Any other error (bad path, permission) → propagate
    const msg = (e as Error).message ?? String(e);
    throw new Error(`wslpath conversion failed for "${p}": ${msg}`);
  }
}

/**
 * Normalize a single file path:
 *  1. Strip LLM artifacts (wrapping quotes, whitespace)
 *  2. Convert Windows drive-letter or UNC paths → POSIX (via wslpath or fallback)
 *  3. Expand ~ to $HOME
 *  4. Resolve relative paths against cwd
 *
 * Returns the resolved POSIX path. Throws with an actionable message on
 * unrecognised Windows/UNC formats or if running outside WSL.
 */
export function normalizePath(raw: string): string {
  // 1. Strip wrapping quotes and trim whitespace
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))
    p = p.slice(1, -1).trim();

  // 2. Convert Windows paths (must come before ~ and relative handling)
  if (WINDOWS_DRIVE_RE.test(p) || UNC_RE.test(p)) {
    if (!isWSL())
      throw new Error(`Windows/UNC path "${p}" cannot be auto-converted: the server is not running under WSL. Provide a native POSIX path instead.`);

    // Primary: wslpath -u
    const viaWslpath = tryWslpath(p);
    if (viaWslpath !== null) {
      p = viaWslpath;
    } else if (WINDOWS_DRIVE_RE.test(p)) {
      // FIXME: fallback passthrough — wslpath unavailable, degrading to /mnt/<drive>/... regex mapping.
      // Owner: expert-tools. Since: 2026-04-16. Remove-by: when wslpath confirmed always present on WSL2.
      p = windowsDriveToMountPath(p);
    } else {
      // UNC path — attempt regex fallback for wsl$ paths only
      const fallback = wslUncToMountPath(p);
      if (fallback !== null) {
        // FIXME: fallback passthrough — wslpath unavailable, degrading to UNC prefix-strip.
        // Owner: expert-tools. Since: 2026-04-16. Remove-by: when wslpath confirmed always present on WSL2.
        p = fallback;
      } else {
        throw new Error(
            `UNC path "${p}" could not be converted: wslpath is unavailable and this does not appear to be a ` +
            `\\\\wsl$\\<Distro>\\... path. Provide a POSIX path (e.g. /mnt/c/...) or install wslpath.`
        );
      }
    }
  }

  // 3. Expand ~ to home directory
  if (p === '~' || p.startsWith('~/'))
    p = path.join(os.homedir(), p.slice(1));

  // 4. Resolve relative paths against cwd
  if (!path.isAbsolute(p))
    p = path.resolve(p);

  return p;
}

/**
 * Validate that all paths exist and are files, with clear error messages
 * that cite both the original caller-supplied path and the resolved POSIX path.
 */
export async function validatePaths(paths: string[], originalPaths: Map<string, string>): Promise<void> {
  for (const filePath of paths) {
    const original = originalPaths.get(filePath) ?? filePath;
    const context = original !== filePath
      ? ` (original input: "${original}", resolved to: "${filePath}")`
      : '';

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT')
        throw new Error(`File not found: "${filePath}"${context}. Ensure the path exists on the server filesystem.`);
      if (code === 'EACCES')
        throw new Error(`Permission denied: "${filePath}"${context}. The server process cannot read this file.`);
      throw new Error(`Cannot access file: "${filePath}"${context} (${code ?? 'unknown error'}).`);
    }
    if (stat.isDirectory())
      throw new Error(`Expected a file but got a directory: "${filePath}"${context}. Provide a path to a specific file.`);
  }
}

// ---------------------------------------------------------------------------
// WSL buffer-based upload
// ---------------------------------------------------------------------------

/**
 * On WSL, file paths are Linux paths (e.g. /home/user/file.pdf) but Chrome
 * runs on Windows and cannot resolve them via CDP DOM.setFileInputFiles.
 * We read the file content in WSL (where the path is valid) and pass it as
 * a buffer payload — Playwright sends the content via CDP, bypassing the
 * WSL-Windows file path boundary entirely.
 */
async function readFilesAsPayloads(paths: string[]): Promise<Array<{ name: string; mimeType: string; buffer: Buffer }>> {
  return Promise.all(paths.map(async filePath => {
    const buffer = await fs.promises.readFile(filePath);
    return {
      name: path.basename(filePath),
      mimeType: mimeTypeForPath(filePath),
      buffer,
    };
  }));
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const uploadFile = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_file_upload',
    title: 'Upload files',
    description: 'Upload one or multiple files. Two modes: ' +
      '(1) click a file input first to trigger the file chooser, then call this tool to fulfill it; or ' +
      '(2) pass `ref` to upload directly to a hidden file input element (no file chooser needed). ' +
      'If `paths` is omitted in modal mode, the file chooser is cancelled.',
    inputSchema: z.object({
      paths: z.array(z.string()).optional().describe(
          'The absolute paths to the files to upload. Can be single file or multiple files. ' +
        'Tilde (~) and relative paths are resolved. Windows paths (C:\\..., C:/...) and ' +
        'UNC paths (\\\\wsl$\\...) are automatically converted to POSIX paths on WSL. ' +
        'If omitted, file chooser is cancelled.'
      ),
      ref: z.string().optional().describe(
          'Exact target element reference from the page snapshot. ' +
        'Use to upload directly to a hidden file input that does not trigger a file chooser modal.'
      ),
      element: z.string().optional().describe(
          'Human-readable element description used to obtain permission to interact with the element'
      ),
      ...snapshotOptionsSchema.shape,
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const modalState = tab.modalStates().find(state => state.type === 'fileChooser');

    // Branch C: both modal and ref provided — ambiguous intent
    if (modalState && params.ref)
      throw new Error('Ambiguous: file chooser modal is open AND `ref` was provided. Use `ref` only for hidden inputs without a modal, or omit `ref` to fulfill the open modal.');

    // Branch D: neither modal nor ref
    if (!modalState && !params.ref)
      throw new Error('No file chooser visible on the page. Either click a file input element first to trigger a file chooser, or pass `ref` to upload directly to a hidden file input.');

    // Branch A: modal-only flow (existing, unchanged)
    if (modalState && !params.ref) {
      if (!params.paths) {
        // Cancel the file chooser
        tab.clearModalState(modalState);
        await tab.waitForCompletion(async () => {});
        return;
      }

      const originalPaths = new Map<string, string>();
      const resolvedPaths = params.paths.map(raw => {
        const resolved = normalizePath(raw);
        if (resolved !== raw)
          originalPaths.set(resolved, raw);
        return resolved;
      });
      await validatePaths(resolvedPaths, originalPaths);

      response.addCode(`await fileChooser.setFiles(${JSON.stringify(resolvedPaths)})`);

      tab.clearModalState(modalState);
      await tab.waitForCompletion(async () => {
        if (isWSL()) {
          const payloads = await readFilesAsPayloads(resolvedPaths);
          await modalState.fileChooser.setFiles(payloads);
        } else {
          await modalState.fileChooser.setFiles(resolvedPaths);
        }
      });
      return;
    }

    // Branch B: ref-only flow — direct setInputFiles on a hidden file input
    // params.ref is defined here; modalState is undefined
    if (!params.paths || params.paths.length === 0)
      throw new Error('`paths` is required when uploading via `ref`. Pass at least one file path.');

    const { locator, resolved } = await tab.refLocator({ ref: params.ref!, element: params.element || 'file input' });

    // Validate element is <input type="file"> before attempting upload
    const elementType = await locator.evaluate((el: Element) => {
      if (!(el instanceof HTMLInputElement))
        return { tag: el.tagName.toLowerCase(), type: null as string | null };
      return { tag: 'input', type: el.type };
    });
    if (elementType.tag !== 'input' || elementType.type !== 'file')
      throw new Error(`Element at ref=${params.ref} is not a file input (got ${elementType.tag}${elementType.type ? `[type=${elementType.type}]` : ''}). browser_file_upload with \`ref\` requires <input type="file">.`);

    const originalPaths = new Map<string, string>();
    const resolvedPaths = params.paths.map(raw => {
      const resolvedPath = normalizePath(raw);
      if (resolvedPath !== raw)
        originalPaths.set(resolvedPath, raw);
      return resolvedPath;
    });
    await validatePaths(resolvedPaths, originalPaths);

    response.addCode(`await page.${resolved}.setInputFiles(${JSON.stringify(resolvedPaths)});`);

    await tab.waitForCompletion(async () => {
      if (isWSL()) {
        const payloads = await readFilesAsPayloads(resolvedPaths);
        await locator.setInputFiles(payloads);
      } else {
        await locator.setInputFiles(resolvedPaths);
      }
    });
  },

  clearsModalState: 'fileChooser',
  clearsModalStateOptional: true,
});

export default [
  uploadFile,
];
