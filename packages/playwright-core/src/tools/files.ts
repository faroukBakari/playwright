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
 * Normalize a single file path:
 *  1. Strip LLM artifacts (wrapping quotes, whitespace)
 *  2. Expand ~ to $HOME
 *  3. Resolve relative paths against cwd
 *  4. Reject Windows-format paths with an actionable error
 */
export function normalizePath(raw: string): string {
  // 1. Strip wrapping quotes and trim whitespace
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))
    p = p.slice(1, -1).trim();

  // 2. Detect Windows paths before any resolution (must come before ~ and relative handling)
  if (WINDOWS_DRIVE_RE.test(p)) {
    const example = p.replace(/\\/g, '/');
    throw new Error(
      `Windows path detected: "${p}". ` +
      `The server runs on Linux/WSL — use a POSIX path instead. ` +
      `Convert with: wslpath -u '${example}'`
    );
  }
  if (UNC_RE.test(p)) {
    throw new Error(
      `UNC path detected: "${p}". ` +
      `The server runs on Linux/WSL — use a POSIX path instead. ` +
      `Convert with: wslpath -u '${p}'`
    );
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
 * Validate that all paths exist and are files, with clear error messages.
 */
export async function validatePaths(paths: string[]): Promise<void> {
  for (const filePath of paths) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT')
        throw new Error(`File not found: "${filePath}". Ensure the path exists on the server filesystem.`);
      if (code === 'EACCES')
        throw new Error(`Permission denied: "${filePath}". The server process cannot read this file.`);
      throw new Error(`Cannot access file: "${filePath}" (${code ?? 'unknown error'}).`);
    }
    if (stat.isDirectory())
      throw new Error(`Expected a file but got a directory: "${filePath}". Provide a path to a specific file.`);
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
  return Promise.all(paths.map(async (filePath) => {
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
    description: 'Upload one or multiple files. Click a file input first to trigger the file chooser, then call this tool. If omitted, file chooser is cancelled.',
    inputSchema: z.object({
      paths: z.array(z.string()).optional().describe('The absolute paths to the files to upload. Can be single file or multiple files. Tilde (~) and relative paths are resolved. If omitted, file chooser is cancelled.'),
      ...snapshotOptionsSchema.shape,
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const modalState = tab.modalStates().find(state => state.type === 'fileChooser');
    if (!modalState)
      throw new Error('No file chooser visible on the page. Click a file input element first to trigger the file chooser, then call browser_file_upload.');

    if (!params.paths) {
      // Cancel the file chooser
      tab.clearModalState(modalState);
      await tab.waitForCompletion(async () => {});
      return;
    }

    // Normalize and validate all paths before attempting upload
    const resolvedPaths = params.paths.map(normalizePath);
    await validatePaths(resolvedPaths);

    response.addCode(`await fileChooser.setFiles(${JSON.stringify(resolvedPaths)})`);

    tab.clearModalState(modalState);
    await tab.waitForCompletion(async () => {
      if (isWSL()) {
        // Read file content in WSL and send as buffer payloads to avoid
        // WSL-Windows path boundary issues with CDP DOM.setFileInputFiles
        const payloads = await readFilesAsPayloads(resolvedPaths);
        await modalState.fileChooser.setFiles(payloads);
      } else {
        await modalState.fileChooser.setFiles(resolvedPaths);
      }
    });
  },

  clearsModalState: 'fileChooser',
});

export default [
  uploadFile,
];
